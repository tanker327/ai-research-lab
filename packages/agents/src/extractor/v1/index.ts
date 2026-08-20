// Extractor v1 (ticket 3.4). One guided-decoding call on the fast tier; a
// parse failure is SCHEMA_FAILURE, which decideRetry maps to re-extract —
// never re-research (P8).
import type { ModelCallContext, ModelTier } from "@lab/schemas";
import { CategorizedError, ExtractorInput, ExtractorOutput } from "@lab/schemas";
import type { Agent, AgentContext } from "../../types";
import { buildMessages, OUTPUT_BUDGET, SYSTEM } from "./prompt";

export const extractorV1: Agent<ExtractorInput, ExtractorOutput> = {
  name: "extractor",
  version: "v1",
  inputSchema: ExtractorInput,
  outputSchema: ExtractorOutput,
  async run(input, ctx: AgentContext): Promise<ExtractorOutput> {
    const note = await ctx.readArtifact(input.noteArtifactId);
    const callCtx: ModelCallContext = {
      runId: ctx.runId,
      taskId: ctx.taskId,
      attemptId: ctx.attemptId,
      tier: ctx.route.tier as ModelTier,
      purpose: "agent",
      createdBy: "extractor/v1",
    };
    const res = await ctx.model.generateStructured({
      ctx: callCtx,
      model: ctx.route.model,
      schema: ExtractorOutput,
      schemaName: "extractor_output",
      mode: ctx.route.mode,
      temperature: 0,
      maxOutputTokens: OUTPUT_BUDGET,
      system: SYSTEM,
      messages: buildMessages(input, note),
    });
    const output = ExtractorOutput.parse(res.object);
    // Referential integrity is code, not prompt. Out-of-range evidenceRefs
    // are DROPPED (gate finding: a fast model repeatedly off-by-one'd its own
    // array and burned all attempts — the ref is linking metadata, and losing
    // one link beats losing the extraction). Invented URLs stay hard
    // failures: that is fabrication, not sloppiness.
    for (const claim of output.claims) {
      claim.evidenceRefs = claim.evidenceRefs.filter((ref) => ref < output.evidence.length);
    }
    const validUrls = new Set(input.sourcesVisited.map((s) => s.url));
    for (const e of output.evidence) {
      if (e.sourceUrl !== null && !validUrls.has(e.sourceUrl)) {
        throw new CategorizedError(
          "SCHEMA_FAILURE",
          `evidence cites '${e.sourceUrl}' which is not in sourcesVisited — URLs from memory are forbidden`,
        );
      }
    }
    return output;
  },
};
