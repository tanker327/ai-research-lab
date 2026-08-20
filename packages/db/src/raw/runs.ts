// Run-level queries for the coordinator and API (tickets 1.7/1.8). Same D1
// split: SQL + typed mappers here, transactions/asserts/events in core.
import type { RunStatus } from "@lab/schemas";
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../client";

export interface RunRow {
  id: string;
  title: string | null;
  userRequest: string;
  status: RunStatus;
  budget: Record<string, unknown>;
  evalCycleCount: number;
  specVersion: number;
  createdAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
}

function mapRun(r: Record<string, unknown>): RunRow {
  return {
    id: r.id as string,
    title: (r.title as string | null) ?? null,
    userRequest: r.user_request as string,
    status: r.status as RunStatus,
    budget: (r.budget as Record<string, unknown>) ?? {},
    evalCycleCount: r.eval_cycle_count as number,
    specVersion: (r.spec_version as number) ?? 0,
    createdAt: String(r.created_at),
    completedAt: r.completed_at ? String(r.completed_at) : null,
    cancelledAt: r.cancelled_at ? String(r.cancelled_at) : null,
  };
}

export async function insertRun(
  tx: SqlExecutor,
  run: {
    id: string;
    title: string | null;
    userRequest: string;
    budget: Record<string, unknown>;
    metadata?: Record<string, unknown>; // e.g. roleTiers (7.1)
  },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO research_runs (id, title, user_request, budget, metadata)
    VALUES (${run.id}, ${run.title}, ${run.userRequest}, ${JSON.stringify(run.budget)}::jsonb,
            ${JSON.stringify(run.metadata ?? {})}::jsonb)`);
}

export async function selectRun(tx: SqlExecutor, runId: string): Promise<RunRow | null> {
  const rows = await tx.execute(sql`SELECT * FROM research_runs WHERE id = ${runId}`);
  const r = rows[0];
  return r ? mapRun(r) : null;
}

export async function getRunForUpdate(tx: SqlExecutor, runId: string): Promise<RunRow | null> {
  const rows = await tx.execute(sql`SELECT * FROM research_runs WHERE id = ${runId} FOR UPDATE`);
  const r = rows[0];
  return r ? mapRun(r) : null;
}

export async function updateRunStatus(
  tx: SqlExecutor,
  runId: string,
  status: RunStatus,
): Promise<void> {
  await tx.execute(sql`
    UPDATE research_runs
    SET status = ${status},
        completed_at = CASE WHEN ${status} IN ('COMPLETED','FAILED') THEN now() ELSE completed_at END,
        cancelled_at = CASE WHEN ${status} = 'CANCELLED' THEN now() ELSE cancelled_at END,
        updated_at = now()
    WHERE id = ${runId}`);
}

export async function selectActiveRuns(tx: SqlExecutor): Promise<RunRow[]> {
  const rows = await tx.execute(sql`
    SELECT * FROM research_runs
    WHERE status NOT IN ('COMPLETED','FAILED','CANCELLED','WAITING_HUMAN')`);
  return [...rows].map(mapRun);
}

export async function taskStatusCounts(
  tx: SqlExecutor,
  runId: string,
): Promise<Record<string, number>> {
  const rows = await tx.execute(sql`
    SELECT status, count(*)::int AS n FROM research_tasks
    WHERE run_id = ${runId} GROUP BY status`);
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.status as string] = r.n as number;
  return counts;
}

export interface NewTask {
  id: string;
  runId: string;
  type: string;
  title: string;
  priority: number;
  strategy: string | null;
  maxAttempts: number;
  input: Record<string, unknown>;
  agentRole: string;
}

// ADR-011: input arrives fully concrete — this insert never templates.
export async function insertTask(tx: SqlExecutor, t: NewTask): Promise<void> {
  await tx.execute(sql`
    INSERT INTO research_tasks (id, run_id, type, title, priority, strategy,
                                max_attempts, input, agent_role)
    VALUES (${t.id}, ${t.runId}, ${t.type}, ${t.title}, ${t.priority}, ${t.strategy},
            ${t.maxAttempts}, ${JSON.stringify(t.input)}::jsonb, ${t.agentRole})`);
}

export async function insertTaskDependency(
  tx: SqlExecutor,
  taskId: string,
  dependsOnTaskId: string,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO task_dependencies (task_id, depends_on_task_id)
    VALUES (${taskId}, ${dependsOnTaskId})`);
}

export interface TaskListRow {
  id: string;
  runId: string;
  type: string;
  title: string;
  status: string;
  priority: number;
  attemptCount: number;
  maxAttempts: number;
  claimedBy: string | null;
  // Staged task board (6.1, ADR-019): stages are the columns; role/strategy/
  // tier feed the inspector drawer badges.
  planStage: number;
  agentRole: string | null;
  strategy: string | null;
  modelTier: string | null;
  createdAt: string;
}

export async function selectTasksByRun(tx: SqlExecutor, runId: string): Promise<TaskListRow[]> {
  const rows = await tx.execute(sql`
    SELECT id, run_id, type, title, status, priority, attempt_count, max_attempts, claimed_by,
           plan_stage, agent_role, strategy, model_tier, created_at
    FROM research_tasks WHERE run_id = ${runId} ORDER BY priority DESC, created_at ASC`);
  return [...rows].map((r) => ({
    id: r.id as string,
    runId: r.run_id as string,
    type: r.type as string,
    title: r.title as string,
    status: r.status as string,
    priority: r.priority as number,
    attemptCount: r.attempt_count as number,
    maxAttempts: r.max_attempts as number,
    claimedBy: (r.claimed_by as string | null) ?? null,
    planStage: (r.plan_stage as number | null) ?? 1,
    agentRole: (r.agent_role as string | null) ?? null,
    strategy: (r.strategy as string | null) ?? null,
    modelTier: (r.model_tier as string | null) ?? null,
    createdAt: String(r.created_at),
  }));
}

// Cancellation (matrix row 10). WHERE pins the from-set to non-terminal
// statuses, all of which may legally go to CANCELLED.
export async function cancelTasksForRun(tx: SqlExecutor, runId: string): Promise<string[]> {
  const rows = await tx.execute(sql`
    UPDATE research_tasks SET status = 'CANCELLED', completed_at = now(), updated_at = now()
    WHERE run_id = ${runId} AND status NOT IN ('DONE','FAILED','CANCELLED')
    RETURNING id`);
  return [...rows].map((r) => r.id as string);
}

export async function cancelAttemptsForRun(tx: SqlExecutor, runId: string): Promise<string[]> {
  const rows = await tx.execute(sql`
    UPDATE attempts SET status = 'CANCELLED', completed_at = now()
    WHERE run_id = ${runId} AND status IN ('CREATED','RUNNING')
    RETURNING id`);
  return [...rows].map((r) => r.id as string);
}

export async function selectRuns(tx: SqlExecutor, limit = 50): Promise<RunRow[]> {
  const rows = await tx.execute(sql`
    SELECT * FROM research_runs ORDER BY created_at DESC LIMIT ${limit}`);
  return [...rows].map(mapRun);
}
