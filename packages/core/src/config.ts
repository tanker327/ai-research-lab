// Typed config (implementation-plan §4): validated with Zod at startup — a
// missing var is a crash at boot, never a runtime surprise.
import { CategorizedError } from "@lab/schemas";
import { z } from "zod";

const intFromEnv = (def: number) => z.coerce.number().int().positive().default(def);

export const ConfigSchema = z.object({
  DATABASE_URL: z.string().min(1),
  ARTIFACT_ROOT: z.string().min(1).default("./data/artifacts"),

  // Pre-flight 2026-08-19: the deployed hub authenticates via the
  // x-service-name header, and tiers bind to hub ALIASES (phase-2-plan D1) —
  // the hub owns which concrete model backs an alias.
  AIHUB_BASE_URL: z.string().url().default("http://192.168.10.114/v1"),
  AIHUB_SERVICE_NAME: z.string().min(1).default("research-lab"),

  // Frontier = "the strongest judge we can reach", not a vendor (user decision
  // 2026-08-19): deepseek-v4-pro via the hub — a real step up from the local
  // strong tier and the flash extractor, no OpenAI/xAI keys needed. Swap to
  // the hub's 'best' alias (+ json_schema mode) if/when those keys exist.
  MODEL_FRONTIER: z.string().min(1).default("deepseek/deepseek-v4-pro"),
  MODEL_STRONG_LOCAL: z.string().min(1).default("default"),
  MODEL_FAST_LOCAL: z.string().min(1).default("cheapest"),

  // D3 closed 2026-08-19: the frontier works (deepseek-v4-pro), so the
  // Planner runs there per the original design. Override to strong_local to
  // save frontier calls; off-frontier planner attempts warn.
  PLANNER_TIER: z.enum(["frontier", "strong_local", "fast_local"]).default("frontier"),
  // 1 now that the frontier is deepseek-v4-pro (working auth). Set to 0 to
  // loudly downgrade all frontier routes to strong_local (TIER_DOWNGRADED
  // warn events) if the frontier model is ever unreachable.
  FRONTIER_ENABLED: z.coerce.number().int().min(0).max(1).default(1),
  // deepseek rejects wire-level json_schema → json_object with prompt-injected
  // schema (D2 machinery). Set to json_schema when frontier moves to openai.
  FRONTIER_STRUCTURED_MODE: z.enum(["json_schema", "json_object"]).default("json_object"),

  // D4 (amended 2026-08-19): self-hosted Firecrawl (SearXNG is its backend —
  // we call Firecrawl, never SearXNG directly). web_search registers and
  // web_fetch scrapes markdown when set.
  FIRECRAWL_BASE_URL: z.string().url().default("http://192.168.10.120:3002"),
  RESEARCHER_MAX_TOOL_CALLS: intFromEnv(8), // deterministic loop cap (ADR-016)
  MIN_EVIDENCE_PER_TASK: intFromEnv(3), // deterministic min-evidence check (3.6)
  MAX_PLAN_STAGES: intFromEnv(2), // staged-planning cap: discovery + deep wave (3.7; Evaluator drives more in P4)

  API_PORT: intFromEnv(8787),
  WORKER_CONCURRENCY: intFromEnv(2),
  GPU_CONCURRENCY_STRONG_LOCAL: intFromEnv(2),
  TASK_CLAIM_TIMEOUT_S: intFromEnv(900),
  POLL_INTERVAL_MS: intFromEnv(500),
  STALE_SWEEP_INTERVAL_MS: intFromEnv(30_000),
  DEFAULT_MAX_ATTEMPTS: intFromEnv(3),
  DEFAULT_MAX_EVAL_CYCLES: intFromEnv(3),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new CategorizedError(
      "PERMANENT_INFRA",
      `Invalid environment configuration — ${missing}`,
      {
        detail: parsed.error.issues,
      },
    );
  }
  return parsed.data;
}
