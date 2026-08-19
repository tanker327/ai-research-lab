// model_calls persistence + reads for the console inspector (tickets 2.1/2.5).
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../client";

export interface NewModelCall {
  id: string;
  runId: string;
  attemptId: string;
  model: string;
  modelTier: string;
  purpose: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  latencyMs: number;
  finishReason: string | null;
  reasoningArtifactId: string | null;
}

export async function insertModelCall(tx: SqlExecutor, c: NewModelCall): Promise<void> {
  await tx.execute(sql`
    INSERT INTO model_calls (id, run_id, attempt_id, model, model_tier, purpose,
                             input_tokens, output_tokens, cost_usd, latency_ms,
                             finish_reason, reasoning_artifact_id)
    VALUES (${c.id}, ${c.runId}, ${c.attemptId}, ${c.model}, ${c.modelTier}, ${c.purpose},
            ${c.inputTokens}, ${c.outputTokens}, ${c.costUsd}, ${c.latencyMs},
            ${c.finishReason}, ${c.reasoningArtifactId})`);
}

export interface ModelCallRow extends NewModelCall {
  createdAt: string;
}

export async function selectModelCallsByAttempt(
  tx: SqlExecutor,
  attemptId: string,
): Promise<ModelCallRow[]> {
  const rows = await tx.execute(sql`
    SELECT * FROM model_calls WHERE attempt_id = ${attemptId} ORDER BY created_at ASC`);
  return [...rows].map((r) => ({
    id: r.id as string,
    runId: r.run_id as string,
    attemptId: r.attempt_id as string,
    model: r.model as string,
    modelTier: r.model_tier as string,
    purpose: r.purpose as string,
    inputTokens: (r.input_tokens as number | null) ?? null,
    outputTokens: (r.output_tokens as number | null) ?? null,
    costUsd: r.cost_usd === null ? null : Number(r.cost_usd),
    latencyMs: r.latency_ms as number,
    finishReason: (r.finish_reason as string | null) ?? null,
    reasoningArtifactId: (r.reasoning_artifact_id as string | null) ?? null,
    createdAt: String(r.created_at),
  }));
}
