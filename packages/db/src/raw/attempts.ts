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
