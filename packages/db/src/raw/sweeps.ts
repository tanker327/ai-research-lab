// Scheduler sweep queries (rule 4, D1): readiness, dependency-failure
// blocking, stale-claim release. Set-based UPDATE ... RETURNING so a sweep is
// one statement per transition kind; the WHERE clause pins the from-status the
// orchestrator asserts. Event emission and transaction boundaries live in
// packages/core/src/scheduler.
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../client";

export interface SweptTask {
  id: string;
  runId: string;
}

function mapSwept(r: Record<string, unknown>): SweptTask {
  return { id: r.id as string, runId: r.run_id as string };
}

// Readiness (design §8.1): CREATED → READY when every required dependency is
// DONE and the run is still active. Budget checks are Phase-4 additions here.
// WAITING_HUMAN joined the exclusion list in 7.2 (phase-7-plan D2): a parked
// run performs no new work — this is both the plan-review hold and a general
// correctness fix (checkpoint-parked runs no longer keep claiming tasks).
export async function promoteReadyTasks(tx: SqlExecutor): Promise<SweptTask[]> {
  const rows = await tx.execute(sql`
    UPDATE research_tasks t
    SET status = 'READY', updated_at = now()
    WHERE t.status = 'CREATED'
      AND EXISTS (
        SELECT 1 FROM research_runs r
        WHERE r.id = t.run_id
          AND r.status NOT IN ('COMPLETED','FAILED','CANCELLED','WAITING_HUMAN'))
      AND NOT EXISTS (
        SELECT 1 FROM task_dependencies d
        JOIN research_tasks dep ON dep.id = d.depends_on_task_id
        WHERE d.task_id = t.id
          AND d.dependency_type = 'required'
          AND dep.status <> 'DONE')
    RETURNING t.id, t.run_id`);
  return [...rows].map(mapSwept);
}

// §9.3 footnote: a required dependency that terminally failed can never make
// this task ready — surface that as BLOCKED instead of leaving it CREATED
// forever. Replanning (Phase 3) is what un-blocks.
export async function blockTasksWithFailedDeps(tx: SqlExecutor): Promise<SweptTask[]> {
  const rows = await tx.execute(sql`
    UPDATE research_tasks t
    SET status = 'BLOCKED', updated_at = now()
    WHERE t.status = 'CREATED'
      AND EXISTS (
        SELECT 1 FROM task_dependencies d
        JOIN research_tasks dep ON dep.id = d.depends_on_task_id
        WHERE d.task_id = t.id
          AND d.dependency_type = 'required'
          AND dep.status IN ('FAILED','CANCELLED'))
    RETURNING t.id, t.run_id`);
  return [...rows].map(mapSwept);
}

export interface StaleClaim {
  taskId: string;
  runId: string;
  attemptId: string;
  claimedBy: string | null;
}

// Locked rows are skipped: a claim mid-write by a live worker is not stale.
export async function selectExpiredClaims(
  tx: SqlExecutor,
  timeoutSeconds: number,
): Promise<StaleClaim[]> {
  const rows = await tx.execute(sql`
    SELECT t.id, t.run_id, t.claimed_by, a.id AS attempt_id
    FROM research_tasks t
    JOIN attempts a ON a.task_id = t.id AND a.status = 'RUNNING'
    WHERE t.status = 'RUNNING'
      AND t.claimed_at < now() - make_interval(secs => ${timeoutSeconds})
    FOR UPDATE OF t SKIP LOCKED`);
  return [...rows].map((r) => ({
    taskId: r.id as string,
    runId: r.run_id as string,
    attemptId: r.attempt_id as string,
    claimedBy: (r.claimed_by as string | null) ?? null,
  }));
}

// Parks the task in EVALUATING, not READY: the retry ladder — not the sweep —
// decides whether/when a re-run happens (rule 10). Sending straight to READY
// bypassed decideRetry entirely, so neither backoff nor the max_attempts cap
// applied — found by the phase gate when a claim timeout shorter than the
// task's work time produced an unbounded reclaim loop.
export async function releaseTaskClaim(tx: SqlExecutor, taskId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE research_tasks
    SET status = 'EVALUATING', claimed_by = NULL, claimed_at = NULL, updated_at = now()
    WHERE id = ${taskId}`);
}
