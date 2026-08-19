// tool_calls persistence + console reads (tickets 2.3/2.5). seq is unique per
// attempt (R13) — the trace is ordered by construction.
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../client";

export interface NewToolCall {
  id: string;
  runId: string;
  attemptId: string;
  seq: number;
  toolName: string;
  request: Record<string, unknown>;
  responseSnippet: string | null;
  responseArtifactId: string | null;
  error: Record<string, unknown> | null;
  latencyMs: number | null;
}

export async function insertToolCall(tx: SqlExecutor, c: NewToolCall): Promise<void> {
  await tx.execute(sql`
    INSERT INTO tool_calls (id, run_id, attempt_id, seq, tool_name, request,
                            response_snippet, response_artifact_id, error, latency_ms)
    VALUES (${c.id}, ${c.runId}, ${c.attemptId}, ${c.seq}, ${c.toolName},
            ${JSON.stringify(c.request)}::jsonb, ${c.responseSnippet}, ${c.responseArtifactId},
            ${c.error === null ? null : JSON.stringify(c.error)}::jsonb, ${c.latencyMs})`);
}

export interface ToolCallRow extends NewToolCall {
  createdAt: string;
}

export async function selectToolCallsByAttempt(
  tx: SqlExecutor,
  attemptId: string,
): Promise<ToolCallRow[]> {
  const rows = await tx.execute(sql`
    SELECT * FROM tool_calls WHERE attempt_id = ${attemptId} ORDER BY seq ASC`);
  return [...rows].map((r) => ({
    id: r.id as string,
    runId: r.run_id as string,
    attemptId: r.attempt_id as string,
    seq: r.seq as number,
    toolName: r.tool_name as string,
    request: (r.request as Record<string, unknown>) ?? {},
    responseSnippet: (r.response_snippet as string | null) ?? null,
    responseArtifactId: (r.response_artifact_id as string | null) ?? null,
    error: (r.error as Record<string, unknown> | null) ?? null,
    latencyMs: (r.latency_ms as number | null) ?? null,
    createdAt: String(r.created_at),
  }));
}
