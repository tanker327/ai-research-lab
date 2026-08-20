// Trace read model reads (ticket 5.3, design §24.2). The trace assembler is
// the sanctioned base-table reader (CLAUDE.md rule 5): a trace must show
// superseded/rejected attempts exactly as they ran — liveness filtering would
// erase the history the trace exists to display.
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../client";

export interface AttemptTraceRow {
  id: string;
  taskId: string;
  runId: string;
  attemptNumber: number;
  status: string;
  agentName: string;
  agentVersion: string;
  model: string | null;
  modelTier: string | null;
  strategy: string | null;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  startedAt: string | null;
  completedAt: string | null;
  taskType: string;
  taskTitle: string;
  planStage: number;
}

export async function selectAttemptForTrace(
  tx: SqlExecutor,
  attemptId: string,
): Promise<AttemptTraceRow | null> {
  const rows = await tx.execute(sql`
    SELECT a.id, a.task_id, a.run_id, a.attempt_number, a.status, a.agent_name,
           a.agent_version, a.model, a.model_tier, a.strategy, a.input, a.output,
           a.error, a.started_at, a.completed_at,
           t.type AS task_type, t.title AS task_title, t.plan_stage
    FROM attempts a JOIN research_tasks t ON t.id = a.task_id
    WHERE a.id = ${attemptId}`);
  const r = [...rows][0];
  if (!r) return null;
  return {
    id: r.id as string,
    taskId: r.task_id as string,
    runId: r.run_id as string,
    attemptNumber: r.attempt_number as number,
    status: r.status as string,
    agentName: r.agent_name as string,
    agentVersion: r.agent_version as string,
    model: (r.model as string | null) ?? null,
    modelTier: (r.model_tier as string | null) ?? null,
    strategy: (r.strategy as string | null) ?? null,
    input: (r.input as Record<string, unknown>) ?? {},
    output: (r.output as Record<string, unknown> | null) ?? null,
    error: (r.error as Record<string, unknown> | null) ?? null,
    startedAt: r.started_at ? String(r.started_at) : null,
    completedAt: r.completed_at ? String(r.completed_at) : null,
    taskType: r.task_type as string,
    taskTitle: r.task_title as string,
    planStage: r.plan_stage as number,
  };
}

export interface ArtifactRefRow {
  id: string;
  type: string;
  name: string;
  mediaType: string;
  sizeBytes: number | null;
  createdBy: string;
}

// References only — content stays in the artifact store; the console fetches
// it on demand. Reasoning artifacts appear here BY DESIGN (§24.2 trace block)
// — the trace renders them; agent contexts never receive them (ADR-018).
export async function selectArtifactRefsByAttempt(
  tx: SqlExecutor,
  attemptId: string,
): Promise<ArtifactRefRow[]> {
  const rows = await tx.execute(sql`
    SELECT id, type, name, media_type, size_bytes, created_by
    FROM artifacts WHERE attempt_id = ${attemptId} ORDER BY created_at ASC`);
  return [...rows].map((r) => ({
    id: r.id as string,
    type: r.type as string,
    name: r.name as string,
    mediaType: r.media_type as string,
    sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
    createdBy: r.created_by as string,
  }));
}

export interface ControlRow {
  source: "event" | "evaluation" | "decision";
  type: string; // event type · evaluator_name · decision_records.type
  kind: string | null; // event kind; null for the other sources
  decision: string | null;
  detail: string; // rationale / reasons / payload — rendered verbatim (§24.2)
  createdAt: string;
}

// Control blocks: events + evaluations + decision records scoped to the
// attempt, merged in time order.
export async function selectControlByAttempt(
  tx: SqlExecutor,
  attemptId: string,
): Promise<ControlRow[]> {
  const rows = await tx.execute(sql`
    SELECT 'event' AS source, type, kind, NULL AS decision,
           payload::text AS detail, created_at
    FROM events WHERE attempt_id = ${attemptId}
    UNION ALL
    SELECT 'evaluation' AS source, evaluator_name AS type, NULL AS kind, decision,
           reasons::text AS detail, created_at
    FROM evaluations WHERE target_type = 'attempt' AND target_id = ${attemptId}
    UNION ALL
    SELECT 'decision' AS source, type, NULL AS kind, decision,
           rationale AS detail, created_at
    FROM decision_records WHERE attempt_id = ${attemptId}
    ORDER BY created_at ASC`);
  return [...rows].map((r) => ({
    source: r.source as ControlRow["source"],
    type: r.type as string,
    kind: (r.kind as string | null) ?? null,
    decision: (r.decision as string | null) ?? null,
    detail: String(r.detail ?? ""),
    createdAt: String(r.created_at),
  }));
}

export interface TranscriptAttemptRef {
  attemptId: string;
  taskId: string;
  taskType: string;
  taskTitle: string;
  planStage: number;
  attemptNumber: number;
  status: string;
  agentName: string;
}

// Staged order for the transcript (§24.5): stage ASC, then task creation,
// then attempt number — every attempt, including superseded/rejected ones.
export async function selectTranscriptAttempts(
  tx: SqlExecutor,
  runId: string,
  planStage?: number,
): Promise<TranscriptAttemptRef[]> {
  const stageFilter = planStage === undefined ? sql`` : sql` AND t.plan_stage = ${planStage}`;
  const rows = await tx.execute(sql`
    SELECT a.id AS attempt_id, t.id AS task_id, t.type AS task_type, t.title AS task_title,
           t.plan_stage, a.attempt_number, a.status, a.agent_name
    FROM attempts a JOIN research_tasks t ON t.id = a.task_id
    WHERE a.run_id = ${runId}${stageFilter}
    ORDER BY t.plan_stage ASC, t.created_at ASC, a.attempt_number ASC`);
  return [...rows].map((r) => ({
    attemptId: r.attempt_id as string,
    taskId: r.task_id as string,
    taskType: r.task_type as string,
    taskTitle: r.task_title as string,
    planStage: r.plan_stage as number,
    attemptNumber: r.attempt_number as number,
    status: r.status as string,
    agentName: r.agent_name as string,
  }));
}

export async function selectPlanStagesOfRun(tx: SqlExecutor, runId: string): Promise<number[]> {
  const rows = await tx.execute(sql`
    SELECT DISTINCT plan_stage FROM research_tasks
    WHERE run_id = ${runId} ORDER BY plan_stage ASC`);
  return [...rows].map((r) => r.plan_stage as number);
}

// Accepted synthesize attempt (the run's report): output carries title +
// citationMap (5.1); the report artifact holds the markdown.
export interface AcceptedSynthesisRow {
  attemptId: string;
  output: Record<string, unknown>;
}

export async function selectAcceptedSynthesis(
  tx: SqlExecutor,
  runId: string,
): Promise<AcceptedSynthesisRow | null> {
  const rows = await tx.execute(sql`
    SELECT a.id, a.output FROM attempts a
    JOIN research_tasks t ON t.id = a.task_id
    WHERE a.run_id = ${runId} AND t.type = 'synthesize' AND a.status = 'ACCEPTED'
    ORDER BY a.completed_at DESC NULLS LAST LIMIT 1`);
  const r = [...rows][0];
  if (!r) return null;
  return {
    attemptId: r.id as string,
    output: (r.output as Record<string, unknown>) ?? {},
  };
}
