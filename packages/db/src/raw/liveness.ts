// Liveness-transaction queries (§5.3, ADR-014, rule 4): accept one attempt,
// retire the rest. The partial unique index idx_attempts_one_accepted is the
// last line of defense — a concurrent double-accept loses at commit here, not
// in application logic. Orchestration lives in packages/core/src/liveness.ts.
import type { AttemptStatus } from "@lab/schemas";
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../client";

export interface AttemptRowForUpdate {
  id: string;
  taskId: string;
  runId: string;
  status: AttemptStatus;
}

export async function getAttemptForUpdate(
  tx: SqlExecutor,
  attemptId: string,
): Promise<AttemptRowForUpdate | null> {
  const rows = await tx.execute(sql`
    SELECT id, task_id, run_id, status FROM attempts
    WHERE id = ${attemptId}
    FOR UPDATE`);
  const r = rows[0];
  return r
    ? {
        id: r.id as string,
        taskId: r.task_id as string,
        runId: r.run_id as string,
        status: r.status as AttemptStatus,
      }
    : null;
}

export interface TaskRowForUpdate {
  id: string;
  runId: string;
  status: string;
}

export async function getTaskForUpdate(
  tx: SqlExecutor,
  taskId: string,
): Promise<TaskRowForUpdate | null> {
  const rows = await tx.execute(sql`
    SELECT id, run_id, status FROM research_tasks
    WHERE id = ${taskId}
    FOR UPDATE`);
  const r = rows[0];
  return r ? { id: r.id as string, runId: r.run_id as string, status: r.status as string } : null;
}

export async function markAttemptAccepted(tx: SqlExecutor, attemptId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE attempts SET status = 'ACCEPTED', completed_at = now()
    WHERE id = ${attemptId}`);
}

// §5.3 step 2 verbatim: prior non-terminal attempts of the task go dark —
// their side-effect rows vanish from the live_* views in this transaction.
export async function supersedePriorAttempts(
  tx: SqlExecutor,
  taskId: string,
  acceptedAttemptId: string,
): Promise<string[]> {
  const rows = await tx.execute(sql`
    UPDATE attempts SET status = 'SUPERSEDED'
    WHERE task_id = ${taskId} AND id != ${acceptedAttemptId}
      AND status IN ('SUCCEEDED','FAILED','REJECTED')
    RETURNING id`);
  return [...rows].map((r) => r.id as string);
}
