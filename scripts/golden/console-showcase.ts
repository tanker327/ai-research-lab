// Console showcase (manual): seeds a KEPT run with real model + tool calls
// so the Attempts inspector has live data. Usage: bun scripts/golden/console-showcase.ts
// Seed a demo run showing Phase 2 capabilities in the console (kept, not cleaned).
import { loadConfig } from "@lab/core";
import { createArtifactStore, createDb, seedRun, seedTask } from "@lab/db";
import { createArtifactReasoningSink, createModelClient, resolveRoute } from "@lab/model";
import { type ModelCallContext, newId } from "@lab/schemas";
import { createToolRegistry, webFetchTool } from "@lab/tools";
import { z } from "zod";

const config = loadConfig();
const { db, sql, close } = createDb(config.DATABASE_URL);
const store = createArtifactStore(config.ARTIFACT_ROOT);
const runId = newId(),
  taskId = newId(),
  attemptId = newId();
await seedRun(db, runId, "Phase 2 showcase — real model + tool calls");
await sql`UPDATE research_runs SET title = 'Phase 2 showcase', status = 'RESEARCHING' WHERE id = ${runId}`;
await seedTask(db, {
  id: taskId,
  runId,
  status: "RUNNING",
  title: "researcher demo task",
  type: "research",
});
await sql`INSERT INTO attempts (id, task_id, run_id, attempt_number, status, agent_name, agent_version, model_tier)
          VALUES (${attemptId}, ${taskId}, ${runId}, 1, 'RUNNING', 'researcher', 'v1', 'strong_local')`;

const client = createModelClient({
  baseUrl: config.AIHUB_BASE_URL,
  serviceName: config.AIHUB_SERVICE_NAME,
  db,
  reasoningSink: createArtifactReasoningSink(store, db),
});
const Schema = z.object({
  category: z.enum(["database", "language", "framework"]),
  confidence: z.enum(["low", "medium", "high"]),
  reasons: z.array(z.string().max(200)).min(1).max(3),
});
const models = {
  frontier: config.MODEL_FRONTIER,
  strong_local: config.MODEL_STRONG_LOCAL,
  fast_local: config.MODEL_FAST_LOCAL,
};
const ctx = (tier: ModelCallContext["tier"]): ModelCallContext => ({
  runId,
  taskId,
  attemptId,
  tier,
  purpose: "agent",
  createdBy: "researcher",
});
for (const [role] of [["researcher"], ["extractor"]] as const) {
  const route = resolveRoute(role, 1, models);
  await client.generateStructured({
    ctx: ctx(route.tier),
    model: route.model,
    schema: Schema,
    schemaName: "classification",
    mode: route.mode,
    temperature: 0,
    maxOutputTokens: 3000,
    messages: [
      { role: "user", content: "Classify: PostgreSQL is a relational database. Respond as JSON." },
    ],
  });
}
const registry = createToolRegistry({ db, store, fetchImpl: fetch }, [webFetchTool]);
const scoped = registry.forAttempt({ runId, taskId, attemptId, role: "researcher" });
await scoped.invoke("web_fetch", { url: "https://example.com" });
await scoped
  .invoke("web_fetch", { url: "https://www.postgresql.org/docs/current/ddl.html" })
  .catch(() => {});
await sql`UPDATE attempts SET status = 'SUCCEEDED', completed_at = now() WHERE id = ${attemptId}`;
await sql`UPDATE research_tasks SET status = 'EVALUATING' WHERE id = ${taskId}`;
console.log(runId);
await close();
