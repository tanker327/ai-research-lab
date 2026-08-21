// Attempt reads for the console inspector (ticket 2.5).
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../client";

export interface AttemptListRow {
  id: string;
  taskId: string;
  attemptNumber: number;
  status: string;
  agentName: string;
  modelTier: string | null;
  error: Record<string, unknown> | null;
  startedAt: string | null;
  completedAt: string | null;
}

export async function selectAttemptsByRun(
  tx: SqlExecutor,
  runId: string,
): Promise<AttemptListRow[]> {
  const rows = await tx.execute(sql`
    SELECT id, task_id, attempt_number, status, agent_name, model_tier, error,
           started_at, completed_at
    FROM attempts WHERE run_id = ${runId}
    ORDER BY created_at ASC`);
  return [...rows].map((r) => ({
    id: r.id as string,
    taskId: r.task_id as string,
    attemptNumber: r.attempt_number as number,
    status: r.status as string,
    agentName: r.agent_name as string,
    modelTier: (r.model_tier as string | null) ?? null,
    error: (r.error as Record<string, unknown> | null) ?? null,
    startedAt: r.started_at ? String(r.started_at) : null,
    completedAt: r.completed_at ? String(r.completed_at) : null,
  }));
}

// The attempt row is created at claim time with the task row's agent_version
// (a 'v1' column default) — the worker stamps the version it ACTUALLY ran so
// the audit trail survives prompt-version bumps (8.4/D6, design §33).
export async function updateAttemptAgentVersion(
  tx: SqlExecutor,
  attemptId: string,
  agentVersion: string,
): Promise<void> {
  await tx.execute(sql`
    UPDATE attempts SET agent_version = ${agentVersion} WHERE id = ${attemptId}`);
}

// SCHEMA_FAILURE errors from a task's prior attempts, newest first (phase-8
// D6): the context builder turns them into schemaFeedback for the next
// attempt — a schema reject or truncation becomes fixable instead of a
// verbatim temp-0 replay.
export interface FailedAttemptError {
  category: string;
  message: string | null;
  detail: Record<string, unknown> | null;
}

export async function selectSchemaFailureErrors(
  tx: SqlExecutor,
  taskId: string,
  limit = 3,
): Promise<FailedAttemptError[]> {
  const rows = await tx.execute(sql`
    SELECT error FROM attempts
    WHERE task_id = ${taskId} AND status = 'FAILED'
      AND error->>'category' = 'SCHEMA_FAILURE'
    ORDER BY attempt_number DESC LIMIT ${limit}`);
  return [...rows].map((r) => {
    const e = (r.error as Record<string, unknown>) ?? {};
    return {
      category: String(e.category ?? "SCHEMA_FAILURE"),
      message: typeof e.message === "string" ? e.message : null,
      detail: (e.detail as Record<string, unknown> | null) ?? null,
    };
  });
}
