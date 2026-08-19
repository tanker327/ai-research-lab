// Planner v1 (ticket 3.2). One structured call; the output is a decision —
// the Control Plane's plan interpreter mutates state (ADR-003).
import type { ModelCallContext, ModelTier } from "@lab/schemas";
import { PlannerInput, PlannerOutput } from "@lab/schemas";
import type { Agent, AgentContext } from "../../types";
import { buildMessages, OUTPUT_BUDGET, SYSTEM } from "./prompt";

export const plannerV1: Agent<PlannerInput, PlannerOutput> = {
  name: "planner",
  version: "v1",
  inputSchema: PlannerInput,
  outputSchema: PlannerOutput,
  async run(input, ctx: AgentContext): Promise<PlannerOutput> {
    const callCtx: ModelCallContext = {
      runId: ctx.runId,
      taskId: ctx.taskId,
      attemptId: ctx.attemptId,
      tier: ctx.route.tier as ModelTier,
      purpose: "agent",
      createdBy: "planner/v1",
    };
    const res = await ctx.model.generateStructured({
      ctx: callCtx,
      model: ctx.route.model,
      schema: PlannerOutput,
      schemaName: "planner_output",
      mode: ctx.route.mode,
      temperature: 0.2,
      maxOutputTokens: OUTPUT_BUDGET,
      // ai v7 rejects system-role rows in `messages` — system goes separately.
      system: SYSTEM,
      messages: buildMessages(input),
    });
    return PlannerOutput.parse(res.object);
  },
};
