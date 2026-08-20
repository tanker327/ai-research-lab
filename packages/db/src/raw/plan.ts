// Plan-interpretation writes (ticket 3.2, design §7, §13). All callers hold a
// transaction owned by packages/core — every write here happens alongside its
// assertTransition and event in the same tx.
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../client";

export async function insertSpec(
  tx: SqlExecutor,
  s: {
    id: string;
    runId: string;
    version: number;
    objective: string;
    scope: string[];
    exclusions: string[];
    constraints: string[];
    successCriteria: string[];
    keyQuestions: string[];
    clarificationsAssumed: string[];
  },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO research_specs (id, run_id, version, objective, scope, exclusions, constraints,
                                success_criteria, key_questions, clarifications_assumed)
    VALUES (${s.id}, ${s.runId}, ${s.version}, ${s.objective},
            ${JSON.stringify(s.scope)}::jsonb, ${JSON.stringify(s.exclusions)}::jsonb,
            ${JSON.stringify(s.constraints)}::jsonb, ${JSON.stringify(s.successCriteria)}::jsonb,
            ${JSON.stringify(s.keyQuestions)}::jsonb,
            ${JSON.stringify(s.clarificationsAssumed)}::jsonb)`);
  await tx.execute(sql`
    UPDATE research_runs SET spec_version = ${s.version}, updated_at = now()
    WHERE id = ${s.runId}`);
}

export async function insertPlanStage(
  tx: SqlExecutor,
  p: {
    id: string;
    runId: string;
    stage: number;
    specVersion: number;
    delta: unknown;
    rationale: string;
  },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO plan_stages (id, run_id, stage, spec_version, delta, rationale)
    VALUES (${p.id}, ${p.runId}, ${p.stage}, ${p.specVersion},
            ${JSON.stringify(p.delta)}::jsonb, ${p.rationale})`);
}

// Full-width task insert for planner-created tasks (insertTask in runs.ts is
// the API-create subset).
export async function insertPlannedTaskRow(
  tx: SqlExecutor,
  t: {
    id: string;
    runId: string;
    planStage: number;
    specVersion: number;
    type: string;
    title: string;
    description: string;
    priority: number;
    agentRole: string;
    modelTier: string | null;
    strategy: string | null;
    input: Record<string, unknown>;
    successCriteria: string[];
    maxAttempts: number;
  },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO research_tasks (id, run_id, plan_stage, spec_version, type, title, description,
                                priority, agent_role, model_tier, strategy, input,
                                success_criteria, max_attempts)
    VALUES (${t.id}, ${t.runId}, ${t.planStage}, ${t.specVersion}, ${t.type}, ${t.title},
            ${t.description}, ${t.priority}, ${t.agentRole}, ${t.modelTier}, ${t.strategy},
            ${JSON.stringify(t.input)}::jsonb, ${JSON.stringify(t.successCriteria)}::jsonb,
            ${t.maxAttempts})`);
}

export async function insertHumanCheckpoint(
  tx: SqlExecutor,
  c: {
    id: string;
    runId: string;
    taskId: string | null;
    reason: string;
    question: string;
  },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO human_checkpoints (id, run_id, task_id, reason, question)
    VALUES (${c.id}, ${c.runId}, ${c.taskId}, ${c.reason}, ${c.question})`);
}

export async function markAttemptRejected(tx: SqlExecutor, attemptId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE attempts SET status = 'REJECTED', completed_at = COALESCE(completed_at, now())
    WHERE id = ${attemptId}`);
}

// R12: the attempt's input is the VERBATIM Context Builder product; output is
// the schema-validated agent decision.
export async function updateAttemptInput(
  tx: SqlExecutor,
  attemptId: string,
  input: unknown,
): Promise<void> {
  await tx.execute(sql`
    UPDATE attempts SET input = ${JSON.stringify(input)}::jsonb WHERE id = ${attemptId}`);
}

export async function updateAttemptOutput(
  tx: SqlExecutor,
  attemptId: string,
  output: unknown,
): Promise<void> {
  await tx.execute(sql`
    UPDATE attempts SET output = ${JSON.stringify(output)}::jsonb WHERE id = ${attemptId}`);
}

export async function selectAttemptOutput(
  tx: SqlExecutor,
  attemptId: string,
): Promise<unknown | null> {
  const rows = await tx.execute(sql`SELECT output FROM attempts WHERE id = ${attemptId}`);
  return [...rows][0]?.output ?? null;
}

// Staged-planning driver reads (3.7): is another plan stage due?
export async function selectMaxPlanStage(tx: SqlExecutor, runId: string): Promise<number> {
  const rows = await tx.execute(
    sql`SELECT coalesce(max(stage), 0)::int AS s FROM plan_stages WHERE run_id = ${runId}`,
  );
  return ([...rows][0]?.s as number) ?? 0;
}

export async function existsPlanTaskForStage(
  tx: SqlExecutor,
  runId: string,
  stage: number,
): Promise<boolean> {
  const rows = await tx.execute(sql`
    SELECT 1 FROM research_tasks
    WHERE run_id = ${runId} AND type = 'plan' AND (input->>'planStage')::int = ${stage}
    LIMIT 1`);
  return [...rows].length > 0;
}

export async function countLiveClaims(tx: SqlExecutor, runId: string): Promise<number> {
  const rows = await tx.execute(
    sql`SELECT count(*)::int AS n FROM live_canonical_claims WHERE run_id = ${runId}`,
  );
  return ([...rows][0]?.n as number) ?? 0;
}

export async function selectAttemptInput(
  tx: SqlExecutor,
  attemptId: string,
): Promise<Record<string, unknown> | null> {
  const rows = await tx.execute(sql`SELECT input FROM attempts WHERE id = ${attemptId}`);
  return ([...rows][0]?.input as Record<string, unknown> | undefined) ?? null;
}

// Endgame reads (ticket 4.4): the analysis-loop driver decides from the
// analyze/evaluate task population — see sweepRunCompletion.
export interface TaskTypeRow {
  id: string;
  type: string;
  status: string;
}

export async function selectAnalysisLoopTasks(
  tx: SqlExecutor,
  runId: string,
): Promise<TaskTypeRow[]> {
  const rows = await tx.execute(sql`
    SELECT id, type, status FROM research_tasks
    WHERE run_id = ${runId} AND type IN ('analyze', 'evaluate')
    ORDER BY created_at`);
  return [...rows].map((r) => ({
    id: r.id as string,
    type: r.type as string,
    status: r.status as string,
  }));
}
