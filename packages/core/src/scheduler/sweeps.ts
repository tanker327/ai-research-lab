// Scheduler sweeps (ticket 1.3): readiness + dependency-blocking on the poll
// interval, stale-claim release on its own slower cadence. Each sweep is one
// transaction; every transition is asserted and emits its event in that same
// transaction (rules 3 and 8).
import {
  blockTasksWithFailedDeps,
  type Db,
  markAttemptFinished,
  promoteReadyTasks,
  releaseTaskClaim,
  selectExpiredClaims,
} from "@lab/db";
import { CategorizedError } from "@lab/schemas";
import { emitEvent } from "../events";
import { assertAttemptTransition } from "../state/attempt";
import { assertTaskTransition } from "../state/task";

const ACTOR = "scheduler";

export interface ReadinessSweepResult {
  ready: string[];
  blocked: string[];
}

export async function sweepReadiness(db: Db): Promise<ReadinessSweepResult> {
  return db.transaction(async (tx) => {
    // Block first: a task with one FAILED dep must never race into READY.
    assertTaskTransition("CREATED", "BLOCKED");
    const blocked = await blockTasksWithFailedDeps(tx);
    for (const t of blocked) {
      await emitEvent(tx, {
        runId: t.runId,
        taskId: t.id,
        type: "TASK_BLOCKED",
        kind: "warn",
        actor: ACTOR,
        payload: { reason: "required dependency FAILED or CANCELLED" },
      });
    }

    assertTaskTransition("CREATED", "READY");
    const ready = await promoteReadyTasks(tx);
    for (const t of ready) {
      await emitEvent(tx, {
        runId: t.runId,
        taskId: t.id,
        type: "TASK_READY",
        kind: "info",
        actor: ACTOR,
      });
    }

    return { ready: ready.map((t) => t.id), blocked: blocked.map((t) => t.id) };
  });
}

// Matrix row 1: a SIGKILLed worker leaves task RUNNING + attempt RUNNING. Past
// the claim timeout the task returns to READY and the orphaned attempt fails
// with TRANSIENT_INFRA — the re-claim writes a fresh attempt, so side-effect
// rows of the dead one stay dark (never ACCEPTED).
export async function sweepStaleClaims(db: Db, timeoutSeconds: number): Promise<string[]> {
  return db.transaction(async (tx) => {
    const stale = await selectExpiredClaims(tx, timeoutSeconds);
    for (const s of stale) {
      assertAttemptTransition("RUNNING", "FAILED");
      assertTaskTransition("RUNNING", "READY");
      const error = new CategorizedError(
        "TRANSIENT_INFRA",
        `claim by ${s.claimedBy ?? "unknown"} expired after ${timeoutSeconds}s — worker presumed dead`,
      );
      await markAttemptFinished(tx, s.attemptId, "FAILED", error.toAttemptError());
      await releaseTaskClaim(tx, s.taskId);
      await emitEvent(tx, {
        runId: s.runId,
        taskId: s.taskId,
        attemptId: s.attemptId,
        type: "TASK_CLAIM_EXPIRED",
        kind: "warn",
        actor: ACTOR,
        payload: { claimedBy: s.claimedBy, timeoutSeconds },
      });
    }
    return stale.map((s) => s.taskId);
  });
}
