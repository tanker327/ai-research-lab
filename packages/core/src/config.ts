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

  MODEL_FRONTIER: z.string().min(1).default("best"),
  MODEL_STRONG_LOCAL: z.string().min(1).default("default"),
  MODEL_FAST_LOCAL: z.string().min(1).default("cheapest"),

  // TEMPORARY routing amendment (phase-3-plan D3, user-approved 2026-08-19):
  // the hub's frontier keys are invalid, so the Planner runs on strong_local
  // and every off-frontier planner attempt emits a warn event. Flip back to
  // 'frontier' the day the keys work.
  PLANNER_TIER: z.enum(["frontier", "strong_local", "fast_local"]).default("strong_local"),

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
