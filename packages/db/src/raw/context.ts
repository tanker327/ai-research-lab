// Context Builder reads (ticket 3.1, design §12). Claim/evidence reads go
// through live_* views ONLY (rule 5) — a superseded attempt's rows must never
// reach an agent context. No artifact reads here: artifacts.type='reasoning'
// is excluded from contexts by construction (ADR-018) because the builders
// never select from artifacts at all.
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../client";

export interface RunContextRow {
  userRequest: string;
  metadata: Record<string, unknown>;
  specVersion: number;
}

export async function selectRunForContext(
  tx: SqlExecutor,
  runId: string,
): Promise<RunContextRow | null> {
  const rows = await tx.execute(sql`
    SELECT user_request, metadata, spec_version FROM research_runs WHERE id = ${runId}`);
  const r = [...rows][0];
  if (!r) return null;
  return {
    userRequest: r.user_request as string,
    metadata: (r.metadata as Record<string, unknown>) ?? {},
    specVersion: r.spec_version as number,
  };
}

export interface SpecRow {
  version: number;
  objective: string;
  scope: string[];
  exclusions: string[];
  constraints: string[];
  successCriteria: string[];
  keyQuestions: string[];
  clarificationsAssumed: string[];
}

export async function selectLatestSpec(tx: SqlExecutor, runId: string): Promise<SpecRow | null> {
  const rows = await tx.execute(sql`
    SELECT version, objective, scope, exclusions, constraints, success_criteria,
           key_questions, clarifications_assumed
    FROM research_specs WHERE run_id = ${runId}
    ORDER BY version DESC LIMIT 1`);
  const r = [...rows][0];
  if (!r) return null;
  return {
    version: r.version as number,
    objective: r.objective as string,
    scope: (r.scope as string[]) ?? [],
    exclusions: (r.exclusions as string[]) ?? [],
    constraints: (r.constraints as string[]) ?? [],
    successCriteria: (r.success_criteria as string[]) ?? [],
    keyQuestions: (r.key_questions as string[]) ?? [],
    clarificationsAssumed: (r.clarifications_assumed as string[]) ?? [],
  };
}

export interface DoneTaskRow {
  id: string;
  title: string;
  type: string;
  output: Record<string, unknown> | null; // the ACCEPTED attempt's output
}

// DONE tasks with their accepted attempt's output — the raw material for
// TaskResultSummary (summarized deterministically in packages/context).
export async function selectDoneTasksWithOutput(
  tx: SqlExecutor,
  runId: string,
): Promise<DoneTaskRow[]> {
  const rows = await tx.execute(sql`
    SELECT t.id, t.title, t.type, a.output
    FROM research_tasks t
    LEFT JOIN attempts a ON a.task_id = t.id AND a.status = 'ACCEPTED'
    WHERE t.run_id = ${runId} AND t.status = 'DONE'
    ORDER BY t.completed_at ASC NULLS LAST, t.created_at ASC`);
  return [...rows].map((r) => ({
    id: r.id as string,
    title: r.title as string,
    type: r.type as string,
    output: (r.output as Record<string, unknown> | null) ?? null,
  }));
}

export interface LiveClaimRow {
  id: string;
  subjectKey: string;
  predicateKey: string;
  statement: string;
  status: string;
  contestNote: string | null;
}

export async function selectLiveClaims(tx: SqlExecutor, runId: string): Promise<LiveClaimRow[]> {
  const rows = await tx.execute(sql`
    SELECT id, subject_key, predicate_key, statement, status, contest_note
    FROM live_canonical_claims WHERE run_id = ${runId}
    ORDER BY subject_key ASC, predicate_key ASC`);
  return [...rows].map((r) => ({
    id: r.id as string,
    subjectKey: r.subject_key as string,
    predicateKey: r.predicate_key as string,
    statement: r.statement as string,
    status: r.status as string,
    contestNote: (r.contest_note as string | null) ?? null,
  }));
}

export interface LiveClaimEvidenceRow {
  canonicalClaimId: string;
  relation: string;
  excerpt: string;
  sourceUrl: string | null;
  sourceClass: string;
  vendorAffiliated: boolean | null;
  benchmarkOrigin: string | null;
  retrievedAt: string;
}

export async function selectLiveClaimEvidence(
  tx: SqlExecutor,
  runId: string,
): Promise<LiveClaimEvidenceRow[]> {
  const rows = await tx.execute(sql`
    SELECT canonical_claim_id, relation, excerpt, source_url, source_class,
           vendor_affiliated, benchmark_origin, retrieved_at
    FROM live_claim_evidence WHERE run_id = ${runId}
    ORDER BY canonical_claim_id ASC, retrieved_at DESC`);
  return [...rows].map((r) => ({
    canonicalClaimId: r.canonical_claim_id as string,
    relation: r.relation as string,
    excerpt: r.excerpt as string,
    sourceUrl: (r.source_url as string | null) ?? null,
    sourceClass: r.source_class as string,
    vendorAffiliated: (r.vendor_affiliated as boolean | null) ?? null,
    benchmarkOrigin: (r.benchmark_origin as string | null) ?? null,
    retrievedAt: String(r.retrieved_at),
  }));
}

export interface TaskContextRow {
  id: string;
  runId: string;
  type: string;
  title: string;
  strategy: string | null;
  input: Record<string, unknown>;
  successCriteria: string[];
  planStage: number;
  specVersion: number;
  priority: number;
}

export async function selectTaskForContext(
  tx: SqlExecutor,
  taskId: string,
): Promise<TaskContextRow | null> {
  const rows = await tx.execute(sql`
    SELECT id, run_id, type, title, strategy, input, success_criteria,
           plan_stage, spec_version, priority
    FROM research_tasks WHERE id = ${taskId}`);
  const r = [...rows][0];
  if (!r) return null;
  return {
    id: r.id as string,
    runId: r.run_id as string,
    type: r.type as string,
    title: r.title as string,
    strategy: (r.strategy as string | null) ?? null,
    input: (r.input as Record<string, unknown>) ?? {},
    successCriteria: (r.success_criteria as string[]) ?? [],
    planStage: r.plan_stage as number,
    specVersion: r.spec_version as number,
    priority: r.priority as number,
  };
}

// Latest accepted analysis output for the Evaluator's context (ticket 4.3).
export async function selectLatestAcceptedAnalysis(
  tx: SqlExecutor,
  runId: string,
): Promise<Record<string, unknown> | null> {
  const rows = await tx.execute(sql`
    SELECT a.output FROM attempts a
    JOIN research_tasks t ON t.id = a.task_id
    WHERE t.run_id = ${runId} AND t.type = 'analyze' AND a.status = 'ACCEPTED'
    ORDER BY a.completed_at DESC NULLS LAST, a.attempt_number DESC LIMIT 1`);
  return ([...rows][0]?.output as Record<string, unknown> | undefined) ?? null;
}

// Final ACCEPT verdict's metadata (acceptedUncertainties etc.) for the
// Synthesizer's context (ticket 5.1) — the report must reproduce every
// accepted uncertainty (§6.6).
export async function selectFinalAcceptMetadata(
  tx: SqlExecutor,
  runId: string,
): Promise<Record<string, unknown> | null> {
  const rows = await tx.execute(sql`
    SELECT metadata FROM evaluations
    WHERE run_id = ${runId} AND target_type = 'run' AND evaluator_type = 'agent'
      AND decision = 'ACCEPT'
    ORDER BY created_at DESC LIMIT 1`);
  return ([...rows][0]?.metadata as Record<string, unknown> | undefined) ?? null;
}
