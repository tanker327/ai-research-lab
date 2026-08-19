// Phase 2 gate (implementation-plan §6, phase-2-plan Session D). A stub
// "test agent" drives the real machinery end-to-end through the deployed
// ai-hub: generateStructured with a deliberately nasty schema against
// strong_local AND fast_local (deepseek); the frontier is ATTEMPTED and
// reported pending if the hub is unkeyed — never silently skipped; a
// web_fetch persists an ordered tool_call with a content-addressed snapshot;
// everything is attempt-owned and visible through the console read API.
// Usage: bun run gate:p2   (spends a few cents at most)

import { loadConfig } from "@lab/core";
import { createArtifactStore, createDb, deleteRun, seedRun, seedTask } from "@lab/db";
import { createArtifactReasoningSink, createModelClient, resolveRoute } from "@lab/model";
import { CategorizedError, type ModelCallContext, newId } from "@lab/schemas";
import { createToolRegistry, webFetchTool } from "@lab/tools";
import { pino } from "pino";
import { z } from "zod";

const config = loadConfig();
const { db, sql, close } = createDb(config.DATABASE_URL);
const store = createArtifactStore(config.ARTIFACT_ROOT);

function fail(msg: string): never {
  throw new Error(`GATE ASSERTION FAILED: ${msg}`);
}

// Deliberately nasty: discriminated union, nested arrays with minima, enums,
// nullable optionals, bounded ints. Every array/string is BOUNDED — the gate
// found that constrained decoding + an unbounded array sends a reasoning-
// exhausted model into a degenerate repeat loop until max_tokens.
const Nasty = z.object({
  verdict: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("supported"),
      citations: z
        .array(
          z.object({
            source: z.string().min(1).max(200),
            year: z.number().int().min(1990).max(2030),
          }),
        )
        .min(1)
        .max(5),
    }),
    z.object({ kind: z.literal("contested"), reason: z.string().min(5).max(500) }),
  ]),
  tags: z
    .array(z.enum(["db", "infra", "language"]))
    .min(1)
    .max(3),
  notes: z.string().max(500).nullable(),
});

const runId = newId();
const taskId = newId();
const attemptId = newId();

try {
  await seedRun(db, runId, "phase-2 gate");
  await seedTask(db, { id: taskId, runId, status: "RUNNING" });
  await sql`INSERT INTO attempts (id, task_id, run_id, attempt_number, status, agent_name, agent_version)
            VALUES (${attemptId}, ${taskId}, ${runId}, 1, 'RUNNING', 'gate-agent', 'v1')`;

  const client = createModelClient({
    baseUrl: config.AIHUB_BASE_URL,
    serviceName: config.AIHUB_SERVICE_NAME,
    db,
    reasoningSink: createArtifactReasoningSink(store, db),
    concurrency: { strong_local: config.GPU_CONCURRENCY_STRONG_LOCAL },
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
    createdBy: "gate-agent",
  });
  const prompt = [
    {
      role: "user" as const,
      content:
        "Assess the claim 'PostgreSQL supports transactional DDL'. It is well-documented and true — cite the PostgreSQL documentation (any plausible year). Tag appropriately. Respond as JSON.",
    },
  ];

  // 1. strong_local + fast_local via the ROUTER (researcher/extractor rules).
  let calls = 0;
  for (const [role, attempt] of [
    ["researcher", 1],
    ["extractor", 1],
  ] as const) {
    const route = resolveRoute(role, attempt, models);
    const res = await client.generateStructured({
      ctx: ctx(route.tier),
      model: route.model,
      schema: Nasty,
      schemaName: "assessment",
      mode: route.mode,
      temperature: 0,
      maxOutputTokens: 4000, // reasoning headroom (2.1 smoke finding)
      messages: prompt,
    });
    calls++;
    const parsed = Nasty.parse(res.object); // belt: gate re-validates
    console.log(
      `  ✓ ${role} → ${route.tier} (${route.model}, ${route.mode}): kind=${parsed.verdict.kind} tags=${parsed.tags.join(",")} · ${res.inputTokens}/${res.outputTokens} tok · $${res.costUsd}`,
    );
  }

  // 2. frontier: attempted, reported pending on missing hub keys — never skipped silently.
  const frontierRoute = resolveRoute("planner", 1, models);
  try {
    const res = await client.generateStructured({
      ctx: ctx("frontier"),
      model: frontierRoute.model,
      schema: Nasty,
      schemaName: "assessment",
      mode: frontierRoute.mode,
      temperature: 0,
      maxOutputTokens: 3000,
      messages: prompt,
    });
    calls++;
    console.log(
      `  ✓ frontier (${frontierRoute.model}): ${JSON.stringify(res.object).slice(0, 80)}…`,
    );
  } catch (err) {
    if (err instanceof CategorizedError && err.category === "PERMANENT_INFRA") {
      console.log(
        `  ⚠ frontier PENDING — hub key not configured (${err.message}). Required before Phase 4 tier escalation.`,
      );
    } else {
      throw err;
    }
  }

  // 3. tool call: web_fetch with snapshot, ordered, attempt-owned.
  const registry = createToolRegistry({ db, store, fetchImpl: fetch }, [webFetchTool]);
  const scoped = registry.forAttempt({ runId, taskId, attemptId, role: "researcher" });
  const fetched = (await scoped.invoke("web_fetch", { url: "https://example.com" })) as {
    snapshotArtifactId: string;
    excerpt: string;
  };
  if (!fetched.excerpt.toLowerCase().includes("example")) fail("web_fetch excerpt looks wrong");
  console.log(`  ✓ web_fetch: snapshot ${fetched.snapshotArtifactId.slice(0, 8)}… persisted`);

  // 4. persistence invariants: every side-effect row is attempt-owned.
  const mc = await sql`SELECT count(*)::int AS n FROM model_calls WHERE attempt_id = ${attemptId}
                       AND cost_usd IS NOT NULL AND input_tokens IS NOT NULL`;
  if ((mc[0]?.n as number) < calls) fail(`expected ≥${calls} priced model_calls, got ${mc[0]?.n}`);
  const tc =
    await sql`SELECT seq, response_artifact_id FROM tool_calls WHERE attempt_id = ${attemptId}`;
  if (tc.length !== 1 || tc[0]?.seq !== 1 || !tc[0]?.response_artifact_id) {
    fail("tool_calls row missing/unordered/without snapshot");
  }
  const snap = await sql`SELECT sha256 FROM artifacts WHERE id = ${tc[0]?.response_artifact_id}`;
  if (!snap[0]?.sha256) fail("snapshot artifact not content-addressed");

  // 5. console visibility: the read API serves what the inspector renders.
  const { createApp } = await import("../../apps/api/src/app");
  const app = createApp({
    db,
    bus: { subscribe: () => () => {}, stop: async () => {} },
    log: pino({ level: "silent" }),
  });
  const attempts = (await (await app.request(`/runs/${runId}/attempts`)).json()) as Array<{
    id: string;
  }>;
  if (attempts[0]?.id !== attemptId) fail("GET /runs/:id/attempts missing the gate attempt");
  const callsRes = (await (await app.request(`/attempts/${attemptId}/calls`)).json()) as {
    modelCalls: unknown[];
    toolCalls: unknown[];
  };
  if (callsRes.modelCalls.length < calls || callsRes.toolCalls.length !== 1) {
    fail("GET /attempts/:id/calls does not serve the persisted calls");
  }
  console.log(
    `  ✓ console read API serves ${callsRes.modelCalls.length} model calls + 1 tool call`,
  );

  console.log("✓ Phase 2 gate passed");
} finally {
  await deleteRun(db, runId);
  await close();
}
