// Router policy — a data table, not code (§5.6). Resolution NEVER silently
// downgrades a tier: if the frontier is unkeyed on the hub, the call fails
// PERMANENT_INFRA naming the key (errors.ts), and the ladder/human decides.
import {
  type AgentRole,
  CategorizedError,
  type ModelTier,
  type ResolvedRoute,
  type RoutingRule,
  type StructuredMode,
} from "@lab/schemas";

// §5.6 verbatim, most-specific-first per role: an attemptGte rule beats the
// base rule once the attempt number reaches it.
export const ROUTING: RoutingRule[] = [
  { role: "planner", tier: "frontier" },
  { role: "evaluator", tier: "frontier" },
  { role: "synthesizer", tier: "frontier" },
  { role: "extractor", tier: "fast_local" },
  { role: "researcher", tier: "strong_local" },
  { role: "researcher", attemptGte: 3, tier: "frontier" }, // ladder escalation
  { role: "analyst", tier: "strong_local" },
];

// D2: structured-output capability per tier, from the pre-flight. Revisit the
// fast_local row if the 'cheapest' alias moves off deepseek.
export const TIER_MODE: Record<ModelTier, StructuredMode> = {
  frontier: "json_schema", // openai — native json_schema once keyed
  strong_local: "json_schema", // local backend constrains decoding (verified)
  fast_local: "json_object", // deepseek rejects json_schema (verified)
  cheap_remote: "json_object",
};

export interface TierModels {
  frontier: string;
  strong_local: string;
  fast_local: string;
  cheap_remote?: string;
}

export function resolveRoute(
  role: AgentRole,
  attemptNumber: number,
  models: TierModels,
  overrideTier?: ModelTier | null,
): ResolvedRoute {
  const tier =
    overrideTier ??
    ROUTING.filter(
      (r) => r.role === role && (r.attemptGte === undefined || attemptNumber >= r.attemptGte),
    )
      // deepest matching rule wins: escalation rows have attemptGte set
      .sort((a, b) => (a.attemptGte ?? 0) - (b.attemptGte ?? 0))
      .at(-1)?.tier;
  if (!tier) {
    throw new CategorizedError("PERMANENT_INFRA", `no routing rule for role '${role}'`);
  }
  const model = models[tier];
  if (!model) {
    throw new CategorizedError(
      "PERMANENT_INFRA",
      `tier '${tier}' has no model alias configured (MODEL_${tier.toUpperCase()}) — never silently downgraded`,
    );
  }
  return { tier, model, mode: TIER_MODE[tier] };
}
