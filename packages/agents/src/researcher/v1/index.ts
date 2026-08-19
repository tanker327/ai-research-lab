// Researcher v1 (ticket 3.3). Pass-1 tool loop: CODE drives the loop with a
// deterministic cap (ADR-016); the model makes one structured step decision
// per turn; the product is a Research Note artifact. sourcesVisited is NOT
// produced here — the worker assembles it from tool_calls rows (§6.2).
import type {
  ModelCallContext,
  ModelMessage,
  ModelTier,
  SelfAssessment,
  WebFetchResult,
  WebSearchResult,
} from "@lab/schemas";
import { CategorizedError, ResearcherInput, researcherStepSchema } from "@lab/schemas";
import { z } from "zod";
import type { Agent, AgentContext } from "../../types";
import { OUTPUT_BUDGET, systemPrompt, transcriptHeader } from "./prompt";

export interface ResearcherAgentResult {
  noteArtifactId: string;
  selfAssessment: SelfAssessment;
}

const AgentResult = z.object({
  noteArtifactId: z.string(),
  selfAssessment: z.object({
    complete: z.boolean(),
    confidence: z.enum(["low", "medium", "high"]),
    gaps: z.array(z.string().max(2000)).max(10),
  }),
});

export const researcherV1: Agent<ResearcherInput, ResearcherAgentResult> = {
  name: "researcher",
  version: "v1",
  inputSchema: ResearcherInput,
  outputSchema: AgentResult,
  async run(input, ctx: AgentContext): Promise<ResearcherAgentResult> {
    const hasSearch = ctx.tools.allowed.includes("web_search") && ctx.searchAvailable;
    const maxSteps = ctx.limits.maxToolCalls;
    const Step = researcherStepSchema(hasSearch);
    const callCtx: ModelCallContext = {
      runId: ctx.runId,
      taskId: ctx.taskId,
      attemptId: ctx.attemptId,
      tier: ctx.route.tier as ModelTier,
      purpose: "agent",
      createdBy: "researcher/v1",
    };

    const messages: ModelMessage[] = [{ role: "user", content: transcriptHeader(input) }];
    for (let step = 0; step <= maxSteps; step++) {
      const remaining = maxSteps - step;
      const res = await ctx.model.generateStructured({
        ctx: callCtx,
        model: ctx.route.model,
        schema: Step,
        schemaName: "researcher_step",
        mode: ctx.route.mode,
        temperature: 0.3,
        maxOutputTokens: OUTPUT_BUDGET,
        system: systemPrompt(hasSearch, maxSteps),
        messages: [
          ...messages,
          {
            role: "user",
            content:
              remaining > 0
                ? `Tool steps remaining: ${remaining}. Next action?`
                : "Tool steps exhausted. You MUST finish now: write the research note from what you have.",
          },
        ],
      });
      const decision = Step.parse(res.object);

      if (decision.action === "finish") {
        const saved = await ctx.saveArtifact({
          type: "research_note",
          name: `research-note ${input.question.slice(0, 80)}`,
          mediaType: "text/markdown",
          content: decision.note,
          createdBy: "researcher/v1",
          metadata: { strategy: input.strategy },
        });
        return { noteArtifactId: saved.id, selfAssessment: decision.selfAssessment };
      }

      if (remaining <= 0) break; // told to finish, chose a tool — cap is code, not prompt
      messages.push({ role: "assistant", content: JSON.stringify(decision) });
      let observation: string;
      try {
        if (decision.action === "fetch") {
          const out = (await ctx.tools.invoke("web_fetch", {
            url: decision.url,
            startChar: decision.startChar ?? 0,
          })) as WebFetchResult;
          const end = out.startChar + out.excerpt.length;
          const more =
            end < out.totalChars
              ? ` — TRUNCATED at char ${end} of ${out.totalChars}; fetch again with startChar=${end} to continue`
              : "";
          observation = `FETCHED ${out.url} (HTTP ${out.status}) [chars ${out.startChar}-${end} of ${out.totalChars}${more}]\n${out.excerpt}`;
        } else {
          const out = (await ctx.tools.invoke("web_search", {
            query: decision.query,
          })) as WebSearchResult;
          observation =
            out.results.length === 0
              ? `SEARCH '${out.query}': no results`
              : `SEARCH '${out.query}':\n${out.results
                  .map((r) => `- ${r.title} — ${r.url}\n  ${r.snippet}`)
                  .join("\n")}`;
        }
      } catch (err) {
        // A failed tool call is an observation, not an attempt failure — the
        // model can route around a dead link. (The registry already persisted
        // the failure as a tool_calls row.)
        observation = `TOOL ERROR: ${CategorizedError.from(err).message}`;
      }
      messages.push({ role: "user", content: observation.slice(0, 17_000) });
    }
    // Unreachable: the last iteration forces finish; a model that still won't
    // finish exhausts the schema into... this.
    throw new CategorizedError(
      "QUALITY_FAILURE",
      `researcher did not finish within ${maxSteps} tool steps (ADR-016 cap)`,
    );
  },
};
