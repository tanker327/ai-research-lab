// Analyst v1 (ticket 4.2). One structured call on strong_local; referential
// integrity of citations is checked by the Control Plane's deterministic
// pre-accept check (unknown ids reject), not trusted to the prompt.
import type { ModelCallContext, ModelTier } from "@lab/schemas";
import { AnalysisOutput, AnalystInput } from "@lab/schemas";
import type { Agent, AgentContext } from "../../types";
import { buildMessages, OUTPUT_BUDGET, SYSTEM } from "./prompt";

export const analystV1: Agent<AnalystInput, AnalysisOutput> = {
  name: "analyst",
  version: "v1",
  inputSchema: AnalystInput,
  outputSchema: AnalysisOutput,
  async run(input, ctx: AgentContext): Promise<AnalysisOutput> {
    const callCtx: ModelCallContext = {
      runId: ctx.runId,
      taskId: ctx.taskId,
      attemptId: ctx.attemptId,
      tier: ctx.route.tier as ModelTier,
      purpose: "agent",
      createdBy: "analyst/v1",
    };
    const res = await ctx.model.generateStructured({
      ctx: callCtx,
      model: ctx.route.model,
      schema: AnalysisOutput,
      schemaName: "analysis_output",
      mode: ctx.route.mode,
      temperature: 0,
      maxOutputTokens: OUTPUT_BUDGET,
      system: SYSTEM,
      messages: buildMessages(input),
    });
    return AnalysisOutput.parse(res.object);
  },
};
