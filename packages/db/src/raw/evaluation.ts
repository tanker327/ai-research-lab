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

// Rule/agent verdict rows (ticket 3.6). evaluator_name like 'check:min_evidence'.
export interface NewEvaluation {
  id: string;
  runId: string;
  targetType: string;
  targetId: string;
  evaluatorType: string;
  evaluatorName: string;
  decision: string;
  reasons: string[];
  metadata: Record<string, unknown>;
}

export async function insertEvaluation(tx: SqlExecutor, e: NewEvaluation): Promise<void> {
  await tx.execute(sql`
    INSERT INTO evaluations (id, run_id, target_type, target_id, evaluator_type, evaluator_name,
                             decision, reasons, metadata)
    VALUES (${e.id}, ${e.runId}, ${e.targetType}, ${e.targetId}, ${e.evaluatorType},
            ${e.evaluatorName}, ${e.decision}, ${JSON.stringify(e.reasons)}::jsonb,
            ${JSON.stringify(e.metadata)}::jsonb)`);
}

// Deterministic-check input (3.6): evidence written by one attempt.
// vendor_affiliated NULL counts as vendor (safety).
export async function selectEvidenceStatsByAttempt(
  tx: SqlExecutor,
  attemptId: string,
): Promise<{ evidenceCount: number; nonVendorCount: number }> {
  const rows = await tx.execute(sql`
    SELECT count(*)::int AS n,
           count(*) FILTER (WHERE vendor_affiliated = false)::int AS non_vendor
    FROM evidence WHERE attempt_id = ${attemptId}`);
  const r = [...rows][0];
  return {
    evidenceCount: (r?.n as number) ?? 0,
    nonVendorCount: (r?.non_vendor as number) ?? 0,
  };
}

// Console read surface (ticket 4.6): evaluator verdicts + human checkpoints.
export interface VerdictRow {
  id: string;
  decision: string;
  reasons: string[];
  metadata: Record<string, unknown>; // cycle, coverage, issues, requiredActions, acceptedUncertainties
  createdAt: string;
}

export async function selectAgentVerdicts(tx: SqlExecutor, runId: string): Promise<VerdictRow[]> {
  const rows = await tx.execute(sql`
    SELECT id, decision, reasons, metadata, created_at FROM evaluations
    WHERE run_id = ${runId} AND evaluator_type = 'agent'
    ORDER BY created_at ASC`);
  return [...rows].map((r) => ({
    id: r.id as string,
    decision: r.decision as string,
    reasons: (r.reasons as string[]) ?? [],
    metadata: (r.metadata as Record<string, unknown>) ?? {},
    createdAt: String(r.created_at),
  }));
}

export interface CheckpointRow {
  id: string;
  taskId: string | null;
  reason: string;
  question: string;
  status: string;
  createdAt: string;
}

export async function selectCheckpointsByRun(
  tx: SqlExecutor,
  runId: string,
): Promise<CheckpointRow[]> {
  const rows = await tx.execute(sql`
    SELECT id, task_id, reason, question, status, created_at FROM human_checkpoints
    WHERE run_id = ${runId} ORDER BY created_at ASC`);
  return [...rows].map((r) => ({
    id: r.id as string,
    taskId: (r.task_id as string | null) ?? null,
    reason: r.reason as string,
    question: r.question as string,
    status: r.status as string,
    createdAt: String(r.created_at),
  }));
}
