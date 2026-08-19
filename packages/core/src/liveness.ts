// Accept + supersede — the liveness transaction (§5.3, ADR-014). One
// transaction flips the live set: the accepted attempt's side effects become
// visible through live_* views, prior attempts' rows go dark, the task is
// DONE, and canonicalization is (in Phase 1: stub-)enqueued. Readers never see
// a mixed state.
import {
  type Db,
  getAttemptForUpdate,
  getTaskForUpdate,
  markAttemptAccepted,
  supersedePriorAttempts,
  updateTaskStatus,
} from "@lab/db";
import { CategorizedError, type TaskStatus } from "@lab/schemas";
import { emitEvent } from "./events";
import { assertAttemptTransition } from "./state/attempt";
import { assertTaskTransition } from "./state/task";

export interface AcceptResult {
  taskId: string;
  supersededAttemptIds: string[];
}

export async function acceptAttempt(
  db: Db,
  attemptId: string,
  actor = "run_coordinator",
): Promise<AcceptResult> {
  return db.transaction(async (tx) => {
    const attempt = await getAttemptForUpdate(tx, attemptId);
    if (!attempt) {
      throw new CategorizedError("PERMANENT_INFRA", `attempt ${attemptId} does not exist`);
    }
    // Throws unless the attempt is SUCCEEDED — accepting a FAILED, SUPERSEDED,
    // or already-ACCEPTED attempt is a bug, not a race to smooth over.
    assertAttemptTransition(attempt.status, "ACCEPTED");

    const task = await getTaskForUpdate(tx, attempt.taskId);
    if (!task) {
      throw new CategorizedError("PERMANENT_INFRA", `task ${attempt.taskId} does not exist`);
    }
    assertTaskTransition(task.status as TaskStatus, "DONE");

    await markAttemptAccepted(tx, attemptId);
    const supersededAttemptIds = await supersedePriorAttempts(tx, attempt.taskId, attemptId);
    await updateTaskStatus(tx, attempt.taskId, "DONE");
    await enqueueCanonicalization(tx, attempt.runId, actor);

    await emitEvent(tx, {
      runId: attempt.runId,
      taskId: attempt.taskId,
      attemptId,
      type: "ATTEMPT_ACCEPTED",
      kind: "accept",
      actor,
      payload: { superseded: supersededAttemptIds },
    });

    return { taskId: attempt.taskId, supersededAttemptIds };
  });
}

// Phase-1 stub (phase-1-plan 1.4): canonicalization re-runs over the changed
// live set from Phase 3 on. Until then the enqueue is an event so traces
// already show where it will happen.
async function enqueueCanonicalization(
  tx: Parameters<typeof emitEvent>[0],
  runId: string,
  actor: string,
): Promise<void> {
  await emitEvent(tx, {
    runId,
    type: "CANONICALIZATION_ENQUEUED",
    kind: "info",
    actor,
    payload: { stub: true },
  });
}
