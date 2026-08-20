// Hot-path claim queries (CLAUDE.md rule 4, decision D1): tagged-template SQL
// with typed row mappers, no business logic. Transaction boundaries, state
// assertions, and event emission live in packages/core.
import type { TaskStatus, TaskType } from "@lab/schemas";
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../client";

export interface ClaimableTaskRow {
  id: string;
  runId: string;
  type: TaskType;
  title: string;
  priority: number;
  agentRole: string;
  agentVersion: string;
  modelTier: string | null;
  strategy: string | null;
  input: unknown;
  maxAttempts: number;
  attemptCount: number;
}

function mapClaimableTask(r: Record<string, unknown>): ClaimableTaskRow {
  return {
    id: r.id as string,
    runId: r.run_id as string,
    type: r.type as TaskType,
    title: r.title as string,
    priority: r.priority as number,
    agentRole: r.agent_role as string,
    agentVersion: r.agent_version as string,
    modelTier: (r.model_tier as string | null) ?? null,
    strategy: (r.strategy as string | null) ?? null,
    input: r.input,
    maxAttempts: r.max_attempts as number,
    attemptCount: r.attempt_count as number,
  };
}

// §5.2: SKIP LOCKED makes concurrent claims race-free — a locked row is
// invisible to other claimers, never a wait.
export async function selectNextReadyTaskForUpdate(
  tx: SqlExecutor,
): Promise<ClaimableTaskRow | null> {
  const rows = await tx.execute(sql`
    SELECT id, run_id, type, title, priority, agent_role, agent_version,
           model_tier, strategy, input, max_attempts, attempt_count
    FROM research_tasks
    WHERE status = 'READY'
    ORDER BY priority DESC, created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1`);
  const row = rows[0];
  return row ? mapClaimableTask(row) : null;
}

// Claim = new attempt, so attempt_count bumps here in the same transaction the
// attempt row is inserted (its attempt_number is the caller's attemptCount + 1).
export async function markTaskClaimed(
  tx: SqlExecutor,
  taskId: string,
  workerId: string,
): Promise<void> {
  await tx.execute(sql`
    UPDATE research_tasks
    SET status = 'RUNNING', claimed_by = ${workerId}, claimed_at = now(),
        started_at = coalesce(started_at, now()),
        attempt_count = attempt_count + 1, updated_at = now()
    WHERE id = ${taskId}`);
}

export interface NewAttempt {
  id: string;
  taskId: string;
  runId: string;
  attemptNumber: number;
  agentName: string;
  agentVersion: string;
  modelTier: string | null;
  strategy: string | null;
  input: unknown;
}

// The attempt is born RUNNING: it exists only because a worker claimed the
// task and is about to execute it. assertTransition governs later updates.
export async function insertRunningAttempt(tx: SqlExecutor, a: NewAttempt): Promise<void> {
  await tx.execute(sql`
    INSERT INTO attempts (id, task_id, run_id, attempt_number, status,
                          agent_name, agent_version, model_tier, strategy, input, started_at)
    VALUES (${a.id}, ${a.taskId}, ${a.runId}, ${a.attemptNumber}, 'RUNNING',
            ${a.agentName}, ${a.agentVersion}, ${a.modelTier}, ${a.strategy},
            ${JSON.stringify(a.input ?? {})}::jsonb, now())`);
}

// Plain status writes — legality is asserted by the caller via assertTransition
// inside the same transaction (rule 3); these functions never decide.
export async function updateTaskStatus(
  tx: SqlExecutor,
  taskId: string,
  status: TaskStatus,
): Promise<void> {
  await tx.execute(sql`
    UPDATE research_tasks
    SET status = ${status},
        completed_at = CASE WHEN ${status} IN ('DONE','FAILED','CANCELLED') THEN now() ELSE completed_at END,
        updated_at = now()
    WHERE id = ${taskId}`);
}

export async function markAttemptFinished(
  tx: SqlExecutor,
  attemptId: string,
  status: "SUCCEEDED" | "FAILED",
  error: unknown | null,
): Promise<void> {
  await tx.execute(sql`
    UPDATE attempts
    SET status = ${status},
        error = ${error === null ? null : JSON.stringify(error)}::jsonb,
        completed_at = now()
    WHERE id = ${attemptId}`);
}

// Intelligence-retry directives (ticket 4.5): the ladder's verdict is APPLIED
// to the task row so the next claim runs with the fallback strategy / the
// escalated tier — recording a verdict nobody executes is not a retry policy.
export async function applyRetryDirectives(
  tx: SqlExecutor,
  taskId: string,
  d: { strategy?: string; modelTier?: string },
): Promise<void> {
  await tx.execute(sql`
    UPDATE research_tasks
    SET strategy = COALESCE(${d.strategy ?? null}, strategy),
        model_tier = COALESCE(${d.modelTier ?? null}, model_tier),
        updated_at = now()
    WHERE id = ${taskId}`);
}
