// Routing contracts (rule 2): the policy TABLE lives in packages/model
// (§5.6); its row shape and the resolved route live here so core/worker/web
// can type against them without importing model code.
import { z } from "zod";
import { ModelTier } from "./enums";
import { StructuredMode } from "./model";

export const AgentRole = z.enum([
  "planner",
  "researcher",
  "extractor",
  "analyst",
  "evaluator",
  "synthesizer",
]);
export type AgentRole = z.infer<typeof AgentRole>;

export const RoutingRule = z.object({
  role: AgentRole,
  tier: ModelTier,
  // Ladder escalation: rule applies from this attempt number on (§5.6).
  attemptGte: z.number().int().positive().optional(),
});
export type RoutingRule = z.infer<typeof RoutingRule>;

export const ResolvedRoute = z.object({
  tier: ModelTier,
  model: z.string().min(1), // hub alias from config (D1)
  mode: StructuredMode, // provider capability (D2)
});
export type ResolvedRoute = z.infer<typeof ResolvedRoute>;

// Run-scoped routing preference (ticket 7.1, phase-7-plan D4): the user picks
// a TIER per role at creation/review time. Resolution order in the worker:
// task-level override (ladder escalations — they outrank a preference) >
// run roleTiers > the policy table. Raw model names stay deployment config.
export const RoleTiers = z.partialRecord(AgentRole, ModelTier);
export type RoleTiers = z.infer<typeof RoleTiers>;
