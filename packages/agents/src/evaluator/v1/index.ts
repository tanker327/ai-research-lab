// Evaluator v1 (ticket 4.3). One frontier call; the decision is interpreted
// by the Control Plane (ADR-003) after deterministic consistency checks
// (anti-rubber-stamp rules live in @lab/core, not here).
import type { ModelCallContext, ModelTier } from "@lab/schemas";
import { EvaluatorInput, EvaluatorOutput } from "@lab/schemas";
import type { Agent, AgentContext } from "../../types";
import { buildMessages, OUTPUT_BUDGET, SYSTEM } from "./prompt";

export const evaluatorV1: Agent<EvaluatorInput, EvaluatorOutput> = {
  name: "evaluator",
  version: "v1",
  inputSchema: EvaluatorInput,
  outputSchema: EvaluatorOutput,
  async run(input, ctx: AgentContext): Promise<EvaluatorOutput> {
    const callCtx: ModelCallContext = {
      runId: ctx.runId,
      taskId: ctx.taskId,
      attemptId: ctx.attemptId,
      tier: ctx.route.tier as ModelTier,
      purpose: "agent",
      createdBy: "evaluator/v1",
    };
    const res = await ctx.model.generateStructured({
      ctx: callCtx,
      model: ctx.route.model,
      schema: EvaluatorOutput,
      schemaName: "evaluator_output",
      mode: ctx.route.mode,
      temperature: 0,
      maxOutputTokens: OUTPUT_BUDGET,
      system: SYSTEM,
      messages: buildMessages(input),
    });
    return EvaluatorOutput.parse(res.object);
  },
};
