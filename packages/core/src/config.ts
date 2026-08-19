// Typed config (implementation-plan §4): validated with Zod at startup — a
// missing var is a crash at boot, never a runtime surprise.
import { CategorizedError } from "@lab/schemas";
import { z } from "zod";

const intFromEnv = (def: number) => z.coerce.number().int().positive().default(def);

export const ConfigSchema = z.object({
  DATABASE_URL: z.string().min(1),
  ARTIFACT_ROOT: z.string().min(1).default("./data/artifacts"),

  AIHUB_BASE_URL: z.string().url(),
  AIHUB_API_KEY: z.string().default(""),

  MODEL_FRONTIER: z.string().min(1),
  MODEL_STRONG_LOCAL: z.string().min(1),
  MODEL_FAST_LOCAL: z.string().min(1),

  WORKER_CONCURRENCY: intFromEnv(2),
  GPU_CONCURRENCY_STRONG_LOCAL: intFromEnv(2),
  TASK_CLAIM_TIMEOUT_S: intFromEnv(900),
  POLL_INTERVAL_MS: intFromEnv(500),
  DEFAULT_MAX_ATTEMPTS: intFromEnv(3),
  DEFAULT_MAX_EVAL_CYCLES: intFromEnv(3),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new CategorizedError("PERMANENT_INFRA", `Invalid environment configuration — ${missing}`, {
      detail: parsed.error.issues,
    });
  }
  return parsed.data;
}
