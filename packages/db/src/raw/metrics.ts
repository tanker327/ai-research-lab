// Run dashboard aggregates (ticket 6.2, D3): one round trip feeding the
// overview metric grid (§24.6 — cycle-guard headroom and the frontier-vs-
// local split are first-class). Live evidence/claims counted through the
// live_* views (rule 5); calls/attempts/tasks are whole-history counts —
// the dashboard shows work performed, not just work that survived.
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../client";

export interface RunDashboardRow {
  tasksTotal: number;
  tasksDone: number;
  tasksFailed: number; // FAILED + BLOCKED + CANCELLED
  tasksResearch: number; // research + extract
  tasksControl: number; // plan + analyze + evaluate + synthesize + human_review
  attemptsTotal: number;
  intelligenceRetries: number;
  tierEscalations: number;
  liveEvidence: number;
  liveClaims: number;
  contestedClaims: number;
  modelCalls: number;
  frontierCalls: number;
  frontierSpendUsd: number | null;
  toolCalls: number;
  toolLatencyMs: number; // total — makes Firecrawl wait visible (P4 finding)
  evalCycles: number; // accepted evaluate attempts
  wallClockSeconds: number; // created_at → completed/cancelled_at or now()
}

export async function selectRunDashboard(tx: SqlExecutor, runId: string): Promise<RunDashboardRow> {
  const rows = await tx.execute(sql`
    SELECT
      (SELECT count(*)::int FROM research_tasks WHERE run_id = ${runId}) AS tasks_total,
      (SELECT count(*)::int FROM research_tasks
        WHERE run_id = ${runId} AND status = 'DONE') AS tasks_done,
      (SELECT count(*)::int FROM research_tasks
        WHERE run_id = ${runId} AND status IN ('FAILED','BLOCKED','CANCELLED')) AS tasks_failed,
      (SELECT count(*)::int FROM research_tasks
        WHERE run_id = ${runId} AND type IN ('research','extract')) AS tasks_research,
      (SELECT count(*)::int FROM research_tasks
        WHERE run_id = ${runId} AND type NOT IN ('research','extract')) AS tasks_control,
      (SELECT count(*)::int FROM attempts WHERE run_id = ${runId}) AS attempts_total,
      (SELECT count(*)::int FROM decision_records
        WHERE run_id = ${runId} AND decision = 'intelligence_retry') AS intelligence_retries,
      (SELECT count(*)::int FROM decision_records
        WHERE run_id = ${runId} AND decision = 'intelligence_retry'
          AND metadata->>'tier' IS NOT NULL) AS tier_escalations,
      (SELECT count(*)::int FROM live_evidence WHERE run_id = ${runId}) AS live_evidence,
      (SELECT count(*)::int FROM live_canonical_claims WHERE run_id = ${runId}) AS live_claims,
      (SELECT count(*)::int FROM live_canonical_claims
        WHERE run_id = ${runId} AND status = 'contested') AS contested_claims,
      (SELECT count(*)::int FROM model_calls WHERE run_id = ${runId}) AS model_calls,
      (SELECT count(*)::int FROM model_calls
        WHERE run_id = ${runId} AND model_tier = 'frontier') AS frontier_calls,
      (SELECT sum(cost_usd) FROM model_calls
        WHERE run_id = ${runId} AND model_tier = 'frontier') AS frontier_spend_usd,
      (SELECT count(*)::int FROM tool_calls WHERE run_id = ${runId}) AS tool_calls,
      (SELECT coalesce(sum(latency_ms), 0)::int FROM tool_calls
        WHERE run_id = ${runId}) AS tool_latency_ms,
      (SELECT count(*)::int FROM attempts a JOIN research_tasks t ON t.id = a.task_id
        WHERE a.run_id = ${runId} AND t.type = 'evaluate'
          AND a.status = 'ACCEPTED') AS eval_cycles,
      (SELECT extract(epoch FROM
          coalesce(r.completed_at, r.cancelled_at, now()) - r.created_at)::int
        FROM research_runs r WHERE r.id = ${runId}) AS wall_clock_seconds`);
  const r = ([...rows][0] ?? {}) as Record<string, unknown>;
  const int = (k: string) => (r[k] as number) ?? 0;
  return {
    tasksTotal: int("tasks_total"),
    tasksDone: int("tasks_done"),
    tasksFailed: int("tasks_failed"),
    tasksResearch: int("tasks_research"),
    tasksControl: int("tasks_control"),
    attemptsTotal: int("attempts_total"),
    intelligenceRetries: int("intelligence_retries"),
    tierEscalations: int("tier_escalations"),
    liveEvidence: int("live_evidence"),
    liveClaims: int("live_claims"),
    contestedClaims: int("contested_claims"),
    modelCalls: int("model_calls"),
    frontierCalls: int("frontier_calls"),
    frontierSpendUsd:
      r.frontier_spend_usd === null || r.frontier_spend_usd === undefined
        ? null
        : Number(r.frontier_spend_usd),
    toolCalls: int("tool_calls"),
    toolLatencyMs: int("tool_latency_ms"),
    evalCycles: int("eval_cycles"),
    wallClockSeconds: int("wall_clock_seconds"),
  };
}
