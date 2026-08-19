// Live ModelClient smoke (ticket 2.1; manual — spends real tokens, tiny).
// Verifies the two working tiers end-to-end through the deployed ai-hub:
// strong_local via json_schema, fast_local (deepseek) via json_object.
// Usage: bun scripts/golden/model-smoke.ts
import { loadConfig } from "@lab/core";
import { createDb, deleteRun, seedRun, seedTask } from "@lab/db";
import { createModelClient } from "@lab/model";
import { type ModelCallContext, newId } from "@lab/schemas";
import { z } from "zod";

const config = loadConfig();
const { db, sql, close } = createDb(config.DATABASE_URL);

const runId = newId();
const taskId = newId();
const attemptId = newId();
await seedRun(db, runId, "model smoke");
await seedTask(db, { id: taskId, runId, status: "RUNNING" });
await sql`INSERT INTO attempts (id, task_id, run_id, attempt_number, status, agent_name, agent_version)
          VALUES (${attemptId}, ${taskId}, ${runId}, 1, 'RUNNING', 'smoke', 'v1')`;

const client = createModelClient({
  baseUrl: config.AIHUB_BASE_URL,
  serviceName: config.AIHUB_SERVICE_NAME,
  db,
});

const Schema = z.object({
  category: z.enum(["database", "language", "framework"]),
  confidence: z.enum(["low", "medium", "high"]),
  reasons: z.array(z.string()).min(1),
});

const ctx = (tier: "strong_local" | "fast_local"): ModelCallContext => ({
  runId,
  taskId,
  attemptId,
  tier,
  purpose: "agent",
  createdBy: "smoke",
});

try {
  for (const [tier, model, mode] of [
    ["strong_local", config.MODEL_STRONG_LOCAL, "json_schema"],
    ["fast_local", config.MODEL_FAST_LOCAL, "json_object"],
  ] as const) {
    const t0 = Date.now();
    const res = await client.generateStructured({
      ctx: ctx(tier),
      model,
      schema: Schema,
      schemaName: "classification",
      mode,
      // The local model reasons before answering; give it thinking headroom
      // or it hits finishReason=length with an empty answer (smoke finding).
      maxOutputTokens: 2000,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: "Classify: PostgreSQL is a relational database. Respond as JSON.",
        },
      ],
    });
    console.log(
      `✓ ${tier} (${model}, ${mode}) → ${JSON.stringify(res.object)} · resolved=${res.model} · ${res.inputTokens}/${res.outputTokens} tok · $${res.costUsd} · ${Date.now() - t0}ms`,
    );
  }
  const rows =
    await sql`SELECT model, model_tier, cost_usd FROM model_calls WHERE run_id = ${runId}`;
  console.log(`✓ ${rows.length} model_calls rows persisted`);
} finally {
  await deleteRun(db, runId);
  await close();
}
