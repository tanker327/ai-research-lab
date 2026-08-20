// Synthesizer v1 (ticket 5.1). One structured call on the frontier tier; NO
// tools (§18: cannot import uncited facts — the allowlist is empty and the
// contract test asserts it). Citation integrity is enforced by the
// deterministic validator (5.2, ADR-020), never trusted to the prompt.
import type { ModelCallContext, ModelTier } from "@lab/schemas";
import { SynthesizerInput, SynthesizerOutput } from "@lab/schemas";
import type { Agent, AgentContext } from "../../types";
import { buildMessages, OUTPUT_BUDGET, SYSTEM } from "./prompt";

export const synthesizerV1: Agent<SynthesizerInput, SynthesizerOutput> = {
  name: "synthesizer",
  version: "v1",
  inputSchema: SynthesizerInput,
  outputSchema: SynthesizerOutput,
  async run(input, ctx: AgentContext): Promise<SynthesizerOutput> {
    const callCtx: ModelCallContext = {
      runId: ctx.runId,
      taskId: ctx.taskId,
      attemptId: ctx.attemptId,
      tier: ctx.route.tier as ModelTier,
      purpose: "agent",
      createdBy: "synthesizer/v1",
    };
    const res = await ctx.model.generateStructured({
      ctx: callCtx,
      model: ctx.route.model,
      schema: SynthesizerOutput,
      schemaName: "synthesizer_output",
      mode: ctx.route.mode,
      temperature: 0,
      maxOutputTokens: OUTPUT_BUDGET,
      system: SYSTEM,
      messages: buildMessages(input),
    });
    return SynthesizerOutput.parse(res.object);
  },
};
