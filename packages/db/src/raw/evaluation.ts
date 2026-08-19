// Evaluation-sweep read (ticket 1.7): tasks parked in EVALUATING joined with
// their latest attempt, plus the task's infra-failure count for the retry
// ladder. One scheduler per deployment (V0.05) — no FOR UPDATE needed; each
// task is then processed in its own transaction by core.
import type { AttemptError, AttemptStatus } from "@lab/schemas";
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../client";

export interface EvaluationCandidate {
  taskId: string;
  runId: string;
  taskType: string;
  strategy: string | null;
  attemptCount: number;
  maxAttempts: number;
  attemptId: string;
  attemptStatus: AttemptStatus;
  attemptNumber: number;
  error: AttemptError | null;
  attemptCompletedAt: Date | null;
  infraFailureCount: number;
}

export async function selectEvaluationCandidates(tx: SqlExecutor): Promise<EvaluationCandidate[]> {
  const rows = await tx.execute(sql`
    SELECT t.id AS task_id, t.run_id, t.type AS task_type, t.strategy,
           t.attempt_count, t.max_attempts,
           a.id AS attempt_id, a.status AS attempt_status, a.attempt_number,
           a.error, a.completed_at AS attempt_completed_at,
           (SELECT count(*)::int FROM attempts ai
            WHERE ai.task_id = t.id
              AND ai.error->>'category' IN ('TRANSIENT_INFRA','TOOL_FAILURE')) AS infra_failure_count
    FROM research_tasks t
    JOIN LATERAL (
      SELECT * FROM attempts WHERE task_id = t.id
      ORDER BY attempt_number DESC LIMIT 1
    ) a ON true
    WHERE t.status = 'EVALUATING'`);
  return [...rows].map((r) => ({
    taskId: r.task_id as string,
    runId: r.run_id as string,
    taskType: r.task_type as string,
    strategy: (r.strategy as string | null) ?? null,
    attemptCount: r.attempt_count as number,
    maxAttempts: r.max_attempts as number,
    attemptId: r.attempt_id as string,
    attemptStatus: r.attempt_status as AttemptStatus,
    attemptNumber: r.attempt_number as number,
    error: (r.error as AttemptError | null) ?? null,
    attemptCompletedAt: r.attempt_completed_at ? new Date(String(r.attempt_completed_at)) : null,
    infraFailureCount: r.infra_failure_count as number,
  }));
}
