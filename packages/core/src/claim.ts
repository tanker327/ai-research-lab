// Atomic claim + attempt lifecycle orchestration (§5.2, decision D1): core
// owns the transaction, calls the raw query functions from @lab/db, asserts
// transitions, and emits events — all in one transaction.
import {
  type ClaimableTaskRow,
  type Db,
  getAttemptForUpdate,
  getTaskForUpdate,
  insertRunningAttempt,
  markAttemptFinished,
  markTaskClaimed,
  selectNextReadyTaskForUpdate,
  updateTaskStatus,
} from "@lab/db";
import { type CategorizedError, newId } from "@lab/schemas";
import { emitEvent } from "./events";
import { assertAttemptTransition } from "./state/attempt";
import { assertTaskTransition } from "./state/task";

export interface ClaimedWork {
  task: ClaimableTaskRow;
  attempt: { id: string; attemptNumber: number };
}

export async function claimNextReadyTask(db: Db, workerId: string): Promise<ClaimedWork | null> {
  return db.transaction(async (tx) => {
    const task = await selectNextReadyTaskForUpdate(tx);
    if (!task) return null;

    assertTaskTransition("READY", "RUNNING");
    await markTaskClaimed(tx, task.id, workerId);

    const attempt = { id: newId(), attemptNumber: task.attemptCount + 1 };
    await insertRunningAttempt(tx, {
      ...attempt,
      taskId: task.id,
      runId: task.runId,
      agentName: task.agentRole,
      agentVersion: task.agentVersion,
      modelTier: task.modelTier,
      strategy: task.strategy,
      input: task.input,
    });

    await emitEvent(tx, {
      runId: task.runId,
      taskId: task.id,
      attemptId: attempt.id,
      type: "TASK_CLAIMED",
      kind: "info",
      actor: workerId,
    });

    return { task, attempt };
  });
}

export type AttemptOutcome = { ok: true } | { ok: false; error: CategorizedError };

// After the handler returns/throws: attempt → SUCCEEDED/FAILED and the task
// parks in EVALUATING (§8.3). What EVALUATING means — accept, retry ladder,
// fail — is decided by the coordinator (tickets 1.4/1.7), not here.
// Returns false when the claim was lost mid-flight (run cancelled, stale
// release) — the worker's result is then discarded, never written (row 10).
export async function finishAttempt(
  db: Db,
  work: ClaimedWork,
  outcome: AttemptOutcome,
): Promise<boolean> {
  const status = outcome.ok ? "SUCCEEDED" : "FAILED";
  return db.transaction(async (tx) => {
    const task = await getTaskForUpdate(tx, work.task.id);
    const attempt = await getAttemptForUpdate(tx, work.attempt.id);
    if (task?.status !== "RUNNING" || attempt?.status !== "RUNNING") return false;
    assertAttemptTransition("RUNNING", status);
    assertTaskTransition("RUNNING", "EVALUATING");
    await markAttemptFinished(
      tx,
      work.attempt.id,
      status,
      outcome.ok ? null : outcome.error.toAttemptError(),
    );
    await updateTaskStatus(tx, work.task.id, "EVALUATING");
    await emitEvent(tx, {
      runId: work.task.runId,
      taskId: work.task.id,
      attemptId: work.attempt.id,
      type: outcome.ok ? "ATTEMPT_SUCCEEDED" : "ATTEMPT_FAILED",
      kind: outcome.ok ? "info" : "fail",
      actor: "worker",
      payload: outcome.ok ? {} : { error: outcome.error.toAttemptError() },
    });
    return true;
  });
}
