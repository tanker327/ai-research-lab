// Trace assembler (ticket 5.3, design §24.2): a DETERMINISTIC assembly of
// stored records into an ordered block sequence — no LLM involved. Lives in
// @lab/db because it is the sanctioned base-table reader (rule 5): traces
// show superseded and rejected attempts exactly as they ran.
import type { SqlExecutor } from "./client";
import { selectModelCallsByAttempt } from "./raw/calls";
import { selectToolCallsByAttempt, type ToolCallRow } from "./raw/toolcalls";
import {
  type ArtifactRefRow,
  type ControlRow,
  selectArtifactRefsByAttempt,
  selectAttemptForTrace,
  selectControlByAttempt,
  selectPlanStagesOfRun,
  selectTranscriptAttempts,
} from "./raw/trace";

export type TraceBlock =
  | { kind: "context_in"; input: Record<string, unknown> }
  | { kind: "reasoning"; artifacts: ArtifactRefRow[] }
  | { kind: "tool_call"; call: ToolCallRow }
  | {
      kind: "output";
      output: Record<string, unknown> | null;
      error: Record<string, unknown> | null;
      artifacts: ArtifactRefRow[]; // note/report/memo refs (non-reasoning)
    }
  | { kind: "control"; entries: ControlRow[] };

export interface AttemptTrace {
  attempt: {
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
    startedAt: string | null;
    completedAt: string | null;
    taskType: string;
    taskTitle: string;
    planStage: number;
    modelCalls: number;
  };
  blocks: TraceBlock[];
}

export async function assembleAttemptTrace(
  tx: SqlExecutor,
  attemptId: string,
): Promise<AttemptTrace | null> {
  const row = await selectAttemptForTrace(tx, attemptId);
  if (!row) return null;
  const [artifacts, toolCalls, control, modelCalls] = await Promise.all([
    selectArtifactRefsByAttempt(tx, attemptId),
    selectToolCallsByAttempt(tx, attemptId),
    selectControlByAttempt(tx, attemptId),
    selectModelCallsByAttempt(tx, attemptId),
  ]);
  const reasoning = artifacts.filter((a) => a.type === "reasoning");
  const outputArtifacts = artifacts.filter((a) => a.type !== "reasoning");

  const blocks: TraceBlock[] = [{ kind: "context_in", input: row.input }];
  if (reasoning.length > 0) blocks.push({ kind: "reasoning", artifacts: reasoning });
  for (const call of toolCalls) blocks.push({ kind: "tool_call", call });
  blocks.push({ kind: "output", output: row.output, error: row.error, artifacts: outputArtifacts });
  if (control.length > 0) blocks.push({ kind: "control", entries: control });

  return {
    attempt: {
      id: row.id,
      taskId: row.taskId,
      runId: row.runId,
      attemptNumber: row.attemptNumber,
      status: row.status,
      agentName: row.agentName,
      agentVersion: row.agentVersion,
      model: row.model,
      modelTier: row.modelTier,
      strategy: row.strategy,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      taskType: row.taskType,
      taskTitle: row.taskTitle,
      planStage: row.planStage,
      modelCalls: modelCalls.length,
    },
    blocks,
  };
}

export interface RunTranscriptPage {
  stage: number;
  stages: number[]; // all stages of the run, for pagination controls
  traces: AttemptTrace[];
}

// Transcript paginated by plan stage (§24.5): one stage per page bounds the
// payload; `stage` defaults to the first stage that exists.
export async function assembleTranscriptPage(
  tx: SqlExecutor,
  runId: string,
  stage?: number,
): Promise<RunTranscriptPage | null> {
  const stages = await selectPlanStagesOfRun(tx, runId);
  if (stages.length === 0) return null;
  const page = stage !== undefined && stages.includes(stage) ? stage : (stages[0] as number);
  const refs = await selectTranscriptAttempts(tx, runId, page);
  const traces: AttemptTrace[] = [];
  for (const ref of refs) {
    const t = await assembleAttemptTrace(tx, ref.attemptId);
    if (t) traces.push(t);
  }
  return { stage: page, stages, traces };
}
