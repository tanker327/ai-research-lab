// Analyst v2 (ticket 8.4, phase-8 D6): v1 + schemaFeedback rendering, id
// discipline, and output-budget pressure in the prompt. Referential integrity
// of citations stays a deterministic Control Plane check.
import type { ModelCallContext, ModelTier } from "@lab/schemas";
import { AnalysisOutput, AnalystInput } from "@lab/schemas";
import type { Agent, AgentContext } from "../../types";
import { buildMessages, OUTPUT_BUDGET, SYSTEM } from "./prompt";

export const analystV2: Agent<AnalystInput, AnalysisOutput> = {
  name: "analyst",
  version: "v2",
  inputSchema: AnalystInput,
  outputSchema: AnalysisOutput,
  async run(input, ctx: AgentContext): Promise<AnalysisOutput> {
    const callCtx: ModelCallContext = {
      runId: ctx.runId,
      taskId: ctx.taskId,
      attemptId: ctx.attemptId,
      tier: ctx.route.tier as ModelTier,
      purpose: "agent",
      createdBy: "analyst/v2",
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
