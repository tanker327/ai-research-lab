// Runtime agent contract (implementation-plan §5.5). The I/O *shapes* live in
// @lab/schemas (rule 2); this file is the execution plumbing: what an agent
// receives at run time. Agents never touch control state (ADR-003) — no db
// handle appears here.
import type { SaveArtifact, SavedArtifact } from "@lab/db";
import type { ModelClient } from "@lab/model";
import type { ScopedTools } from "@lab/tools";
import type { z } from "zod";

export interface AgentContext {
  runId: string;
  taskId: string;
  attemptId: string;
  attemptNumber: number;
  model: ModelClient;
  route: { tier: string; model: string; mode: "json_schema" | "json_object" };
  tools: ScopedTools;
  // Bound to the attempt by the worker — agents never hold a db handle.
  saveArtifact(
    a: Omit<SaveArtifact, "id" | "runId" | "taskId" | "attemptId">,
  ): Promise<SavedArtifact>;
  searchAvailable: boolean; // D4: web_search registered only when SEARXNG is configured
  limits: { maxToolCalls: number }; // ADR-016: loop caps are code, not prompt
  signal: AbortSignal;
}

export interface Agent<I, O> {
  readonly name: string;
  readonly version: string;
  readonly inputSchema: z.ZodType<I>;
  readonly outputSchema: z.ZodType<O>;
  run(input: I, ctx: AgentContext): Promise<O>;
}
