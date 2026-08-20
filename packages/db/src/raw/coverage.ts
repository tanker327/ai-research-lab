// Coverage aggregation reads (ticket 4.1, schema doc §9.4, phase-4-plan D2).
// Deterministic facts over live_* views only (rule 5). vendor_affiliated NULL
// counts as vendor — unknown affiliation must not launder into "independent".
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../client";

export interface CoverageOverallRow {
  evidenceCount: number;
  distinctPublishers: number;
  distinctOrigins: number;
  vendorRatio: number;
  oldestEvidence: string | null;
  newestEvidence: string | null;
  claimCount: number;
  contestedCount: number;
}

export async function selectCoverageOverall(
  tx: SqlExecutor,
  runId: string,
): Promise<CoverageOverallRow> {
  const rows = await tx.execute(sql`
    SELECT
      (SELECT count(*)::int FROM live_evidence WHERE run_id = ${runId}) AS evidence_count,
      (SELECT count(DISTINCT publisher)::int FROM live_evidence
        WHERE run_id = ${runId} AND publisher IS NOT NULL) AS distinct_publishers,
      (SELECT count(DISTINCT benchmark_origin)::int FROM live_evidence
        WHERE run_id = ${runId} AND benchmark_origin IS NOT NULL) AS distinct_origins,
      (SELECT coalesce(avg(CASE WHEN vendor_affiliated IS DISTINCT FROM false
                                THEN 1.0 ELSE 0.0 END), 0)::float
        FROM live_evidence WHERE run_id = ${runId}) AS vendor_ratio,
      (SELECT min(published_at) FROM live_evidence WHERE run_id = ${runId}) AS oldest,
      (SELECT max(published_at) FROM live_evidence WHERE run_id = ${runId}) AS newest,
      (SELECT count(*)::int FROM live_canonical_claims WHERE run_id = ${runId}) AS claim_count,
      (SELECT count(*)::int FROM live_canonical_claims
        WHERE run_id = ${runId} AND status = 'contested') AS contested_count`);
  const r = [...rows][0] as Record<string, unknown>;
  return {
    evidenceCount: (r.evidence_count as number) ?? 0,
    distinctPublishers: (r.distinct_publishers as number) ?? 0,
    distinctOrigins: (r.distinct_origins as number) ?? 0,
    vendorRatio: (r.vendor_ratio as number) ?? 0,
    oldestEvidence: r.oldest ? new Date(String(r.oldest)).toISOString() : null,
    newestEvidence: r.newest ? new Date(String(r.newest)).toISOString() : null,
    claimCount: (r.claim_count as number) ?? 0,
    contestedCount: (r.contested_count as number) ?? 0,
  };
}

export interface SourceClassMixRow {
  sourceClass: string;
  count: number;
}

export async function selectSourceClassMix(
  tx: SqlExecutor,
  runId: string,
): Promise<SourceClassMixRow[]> {
  const rows = await tx.execute(sql`
    SELECT source_class, count(*)::int AS n FROM live_evidence
    WHERE run_id = ${runId} GROUP BY source_class ORDER BY n DESC, source_class`);
  return [...rows].map((r) => ({
    sourceClass: r.source_class as string,
    count: r.n as number,
  }));
}

// Per-key-question coverage: the key question IS the research task's
// researchQuestion (raw_claims/evidence task lineage) — derived, never
// prompted (phase-4-plan D2). Tasks without a researchQuestion (fake/seed
// tasks) are skipped. Claims counted as DISTINCT canonical ids so merged
// duplicates don't inflate a question's coverage.
export interface QuestionCoverageRow {
  question: string;
  taskStatus: string;
  evidenceCount: number;
  claimCount: number;
  distinctPublishers: number;
  vendorRatio: number;
}

export async function selectCoveragePerQuestion(
  tx: SqlExecutor,
  runId: string,
): Promise<QuestionCoverageRow[]> {
  const rows = await tx.execute(sql`
    SELECT t.input->>'researchQuestion' AS question, t.status AS task_status,
           (SELECT count(*)::int FROM live_evidence le WHERE le.task_id = t.id) AS evidence_count,
           (SELECT count(DISTINCT lrc.canonical_claim_id)::int FROM live_raw_claims lrc
             WHERE lrc.task_id = t.id AND lrc.canonical_claim_id IS NOT NULL) AS claim_count,
           (SELECT count(DISTINCT le.publisher)::int FROM live_evidence le
             WHERE le.task_id = t.id AND le.publisher IS NOT NULL) AS distinct_publishers,
           (SELECT coalesce(avg(CASE WHEN le.vendor_affiliated IS DISTINCT FROM false
                                     THEN 1.0 ELSE 0.0 END), 0)::float
             FROM live_evidence le WHERE le.task_id = t.id) AS vendor_ratio
    FROM research_tasks t
    WHERE t.run_id = ${runId} AND t.type = 'research'
      AND t.input->>'researchQuestion' IS NOT NULL
    ORDER BY t.created_at`);
  return [...rows].map((r) => ({
    question: r.question as string,
    taskStatus: r.task_status as string,
    evidenceCount: (r.evidence_count as number) ?? 0,
    claimCount: (r.claim_count as number) ?? 0,
    distinctPublishers: (r.distinct_publishers as number) ?? 0,
    vendorRatio: (r.vendor_ratio as number) ?? 0,
  }));
}

// Cycle count = accepted evaluate attempts (phase-4-plan D3: one cycle = one
// accepted evaluate attempt). The ADR-016 guard and RunMetrics both read this.
export async function selectAcceptedEvaluationCycles(
  tx: SqlExecutor,
  runId: string,
): Promise<number> {
  const rows = await tx.execute(sql`
    SELECT count(*)::int AS n FROM attempts a
    JOIN research_tasks t ON t.id = a.task_id
    WHERE t.run_id = ${runId} AND t.type = 'evaluate' AND a.status = 'ACCEPTED'`);
  return ([...rows][0]?.n as number) ?? 0;
}

export interface RunMetricsRow {
  attemptsUsed: number;
  tasksDone: number;
  tasksFailed: number;
  cyclesCompleted: number;
  costUsd: number | null;
}

export async function selectRunMetrics(tx: SqlExecutor, runId: string): Promise<RunMetricsRow> {
  const cycles = await selectAcceptedEvaluationCycles(tx, runId);
  const rows = await tx.execute(sql`
    SELECT
      (SELECT count(*)::int FROM attempts WHERE run_id = ${runId}) AS attempts_used,
      (SELECT count(*)::int FROM research_tasks
        WHERE run_id = ${runId} AND status = 'DONE') AS tasks_done,
      (SELECT count(*)::int FROM research_tasks
        WHERE run_id = ${runId} AND status IN ('FAILED','BLOCKED','CANCELLED')) AS tasks_failed,
      (SELECT sum(cost_usd) FROM model_calls WHERE run_id = ${runId}) AS cost_usd`);
  const r = [...rows][0] as Record<string, unknown>;
  return {
    attemptsUsed: (r.attempts_used as number) ?? 0,
    tasksDone: (r.tasks_done as number) ?? 0,
    tasksFailed: (r.tasks_failed as number) ?? 0,
    cyclesCompleted: cycles,
    costUsd: r.cost_usd === null || r.cost_usd === undefined ? null : Number(r.cost_usd),
  };
}
