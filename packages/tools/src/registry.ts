// Scoped tool registry (ticket 2.3): per-role allowlists enforced in code,
// every invocation persisted as an ordered tool_calls row (R13) — including
// denials and failures. Agents get a scope bound to their attempt; they never
// see the registry itself.
import { type ArtifactStore, type Db, insertToolCall } from "@lab/db";
import { type AgentRole, CategorizedError, newId, type ToolName } from "@lab/schemas";

export interface ToolScopeContext {
  runId: string;
  taskId?: string | null;
  attemptId: string;
  role: AgentRole;
}

export interface ToolDeps {
  db: Db;
  store: ArtifactStore;
  fetchImpl: typeof globalThis.fetch;
}

export interface ToolOutcome {
  output: unknown;
  snippet: string;
  artifactId?: string | null;
}

export interface ToolDef {
  name: ToolName;
  run(input: unknown, ctx: ToolScopeContext, deps: ToolDeps): Promise<ToolOutcome>;
}

// Per-role allowlists: only the Researcher touches the web in V0.05. The
// Synthesizer is deliberately denied (approved-material-only, design §6).
export const ROLE_TOOL_ALLOWLIST: Record<AgentRole, ToolName[]> = {
  planner: [],
  researcher: ["web_fetch", "web_search"],
  extractor: [],
  analyst: [],
  evaluator: [],
  synthesizer: [],
};

export interface ScopedTools {
  invoke(name: ToolName, input: unknown): Promise<unknown>;
  allowed: ToolName[];
}

export function createToolRegistry(deps: ToolDeps, defs: ToolDef[]) {
  const byName = new Map(defs.map((d) => [d.name, d]));

  return {
    forAttempt(ctx: ToolScopeContext): ScopedTools {
      let seq = 0; // fresh per attempt — a re-run is a new attempt, new scope
      const allowed = ROLE_TOOL_ALLOWLIST[ctx.role];

      async function record(
        name: string,
        input: unknown,
        outcome: { snippet?: string; artifactId?: string | null; error?: CategorizedError },
        latencyMs: number | null,
      ): Promise<void> {
        seq += 1;
        await insertToolCall(deps.db, {
          id: newId(),
          runId: ctx.runId,
          attemptId: ctx.attemptId,
          seq,
          toolName: name,
          request: { input },
          responseSnippet: outcome.snippet ?? null,
          responseArtifactId: outcome.artifactId ?? null,
          error: outcome.error ? outcome.error.toAttemptError() : null,
          latencyMs,
        });
      }

      return {
        allowed,
        async invoke(name, input) {
          if (!allowed.includes(name)) {
            const error = new CategorizedError(
              "TOOL_FAILURE",
              `tool '${name}' is not allowlisted for role '${ctx.role}'`,
              { detail: { allowed } },
            );
            await record(name, input, { error }, null);
            throw error;
          }
          const def = byName.get(name);
          if (!def) {
            const error = new CategorizedError("TOOL_FAILURE", `tool '${name}' is not registered`);
            await record(name, input, { error }, null);
            throw error;
          }
          const t0 = Date.now();
          try {
            const outcome = await def.run(input, ctx, deps);
            await record(name, input, outcome, Date.now() - t0);
            return outcome.output;
          } catch (err) {
            const error = CategorizedError.from(err, "TOOL_FAILURE");
            await record(name, input, { error }, Date.now() - t0);
            throw error;
          }
        },
      };
    },
  };
}
