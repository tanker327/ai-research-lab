// Ticket 2.1 contract tests: stubbed fetch (no live models), real Postgres
// for the persistence rows. Asserts the wire shape (auth header,
// response_format per D2 mode), schema validation → SCHEMA_FAILURE, the
// error-taxonomy mapping, and that every call writes an attempt-owned
// model_calls row (rule 5).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArtifactStore, createDb, deleteRun, seedRun, seedTask } from "@lab/db";
import { type ModelCallContext, newId } from "@lab/schemas";
import postgres from "postgres";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createModelClient } from "./client";
import { createArtifactReasoningSink } from "./reasoning";

const url = process.env.DATABASE_URL ?? "postgres://lab:lab@localhost:5434/research_lab";
const { db, close } = createDb(url);
const raw = postgres(url);

let runId: string;
let ctx: ModelCallContext;

beforeEach(async () => {
  runId = newId();
  const taskId = newId();
  const attemptId = newId();
  await seedRun(db, runId);
  await seedTask(db, { id: taskId, runId, status: "RUNNING" });
  await raw`INSERT INTO attempts (id, task_id, run_id, attempt_number, status, agent_name, agent_version)
            VALUES (${attemptId}, ${taskId}, ${runId}, 1, 'RUNNING', 'test-agent', 'v1')`;
  ctx = {
    runId,
    taskId,
    attemptId,
    tier: "strong_local",
    purpose: "agent",
    createdBy: "test-agent",
  };
});

afterEach(async () => {
  await deleteRun(db, runId);
});

afterAll(async () => {
  await close();
  await raw.end();
});

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

// Stub fetch: captures the outgoing request, returns a canned OpenAI-shape
// chat completion (or an error response).
function stubFetch(
  respond: (req: CapturedRequest) => { status: number; json: unknown },
  captured: CapturedRequest[] = [],
): { fetch: typeof globalThis.fetch; captured: CapturedRequest[] } {
  const fetchImpl = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const req: CapturedRequest = {
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    };
    captured.push(req);
    const { status, json } = respond(req);
    return new Response(JSON.stringify(json), {
      status,
      headers: { "content-type": "application/json", "x-hub-cost-usd": "0.0012340000" },
    });
  }) as typeof globalThis.fetch;
  return { fetch: fetchImpl, captured };
}

function completion(content: string, extra: Record<string, unknown> = {}) {
  return {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1,
    model: "local-llm/resolved-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content, ...extra },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 42, completion_tokens: 7 },
  };
}

const Classification = z.object({
  category: z.enum(["database", "language"]),
  confidence: z.enum(["low", "medium", "high"]),
});

const makeClient = (
  fetchImpl: typeof globalThis.fetch,
  sink?: Parameters<typeof createModelClient>[0]["reasoningSink"],
) =>
  createModelClient({
    baseUrl: "http://hub.test/v1",
    serviceName: "research-lab",
    db,
    fetch: fetchImpl,
    reasoningSink: sink,
  });

const messages = [{ role: "user" as const, content: "classify postgres" }];

describe("generateStructured", () => {
  it("json_schema mode: sends response_format json_schema + auth header, returns the parsed object, persists the call", async () => {
    const { fetch, captured } = stubFetch(() => ({
      status: 200,
      json: completion(JSON.stringify({ category: "database", confidence: "high" })),
    }));
    const client = makeClient(fetch);

    const res = await client.generateStructured({
      ctx,
      model: "default",
      schema: Classification,
      schemaName: "classification",
      mode: "json_schema",
      messages,
    });

    expect(res.object).toEqual({ category: "database", confidence: "high" });
    expect(res.model).toBe("local-llm/resolved-model");
    expect(res.costUsd).toBeCloseTo(0.001234);

    const req = captured[0];
    expect(req?.headers["x-service-name"]).toBe("research-lab");
    const rf = req?.body.response_format as { type: string; json_schema?: { schema: unknown } };
    expect(rf.type).toBe("json_schema");
    expect(rf.json_schema?.schema).toBeTruthy();

    const [row] = await raw`SELECT * FROM model_calls WHERE attempt_id = ${ctx.attemptId}`;
    expect(row).toMatchObject({
      run_id: runId,
      model: "local-llm/resolved-model",
      model_tier: "strong_local",
      purpose: "agent",
      input_tokens: 42,
      output_tokens: 7,
      finish_reason: "stop",
    });
    expect(Number(row?.cost_usd)).toBeCloseTo(0.001234);
  });

  it("json_object mode (deepseek path, D2): no json_schema on the wire; Zod still validates", async () => {
    const { fetch, captured } = stubFetch(() => ({
      status: 200,
      json: completion(JSON.stringify({ category: "database", confidence: "medium" })),
    }));
    const client = makeClient(fetch);

    const res = await client.generateStructured({
      ctx,
      model: "cheapest",
      schema: Classification,
      mode: "json_object",
      messages,
    });
    expect(res.object.confidence).toBe("medium");
    const rf = captured[0]?.body.response_format as { type: string } | undefined;
    expect(rf?.type).not.toBe("json_schema");
    // Without a wire-level schema the model must see it in the prompt (live
    // deepseek finding: it invents its own shape otherwise).
    const msgs = captured[0]?.body.messages as Array<{ role: string; content: string }>;
    const system = msgs.find((m) => m.role === "system");
    expect(system?.content).toContain("JSON Schema");
    expect(system?.content).toContain("confidence");
  });

  it("schema-invalid output → SCHEMA_FAILURE (never best-effort, rule 7)", async () => {
    const { fetch } = stubFetch(() => ({
      status: 200,
      json: completion(JSON.stringify({ category: "spaceship" })),
    }));
    const client = makeClient(fetch);

    const err = await client
      .generateStructured({ ctx, model: "default", schema: Classification, messages })
      .catch((e) => e);
    expect(err).toMatchObject({ name: "CategorizedError", category: "SCHEMA_FAILURE" });
  });

  it("persists reasoning through the sink and links the artifact", async () => {
    const artifactId = newId();
    const seen: string[] = [];
    const sink = async (_ctx: ModelCallContext, reasoning: string) => {
      seen.push(reasoning);
      await raw`INSERT INTO artifacts (id, run_id, attempt_id, type, name, storage_uri, created_by)
                VALUES (${artifactId}, ${runId}, ${ctx.attemptId}, 'reasoning', 'r', 'test://r', 'system')`;
      return artifactId;
    };
    const { fetch } = stubFetch(() => ({
      status: 200,
      json: completion(JSON.stringify({ category: "database", confidence: "low" }), {
        reasoning_content: "thinking about databases…",
      }),
    }));
    const client = makeClient(fetch, sink);

    await client.generateStructured({ ctx, model: "default", schema: Classification, messages });
    expect(seen).toEqual(["thinking about databases…"]);
    const [row] = await raw`SELECT reasoning_artifact_id FROM model_calls
                            WHERE attempt_id = ${ctx.attemptId}`;
    expect(row?.reasoning_artifact_id).toBe(artifactId);
  });
});

describe("error taxonomy mapping", () => {
  it.each([
    [429, "TRANSIENT_INFRA"],
    [500, "TRANSIENT_INFRA"],
    [401, "PERMANENT_INFRA"],
    [404, "PERMANENT_INFRA"],
  ])("HTTP %i → %s", async (status, category) => {
    const { fetch } = stubFetch(() => ({ status, json: { error: { message: "boom" } } }));
    const client = makeClient(fetch);
    const err = await client
      .generateStructured({ ctx, model: "default", schema: Classification, messages })
      .catch((e) => e);
    expect(err).toMatchObject({ name: "CategorizedError", category });
  });

  it("transport failure → TRANSIENT_INFRA; nothing persisted", async () => {
    const failingFetch = (async () => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    }) as unknown as typeof globalThis.fetch;
    const client = makeClient(failingFetch);
    const err = await client
      .generateStructured({ ctx, model: "default", schema: Classification, messages })
      .catch((e) => e);
    expect(err).toMatchObject({ category: "TRANSIENT_INFRA" });
    const rows = await raw`SELECT * FROM model_calls WHERE attempt_id = ${ctx.attemptId}`;
    expect(rows).toHaveLength(0);
  });
});

describe("reasoning sink over the real artifact store (2.4 wiring)", () => {
  it("stores reasoning as a type='reasoning' artifact linked from the call", async () => {
    const store = createArtifactStore(mkdtempSync(join(tmpdir(), "lab-reasoning-")));
    const sink = createArtifactReasoningSink(store, db);
    const { fetch } = stubFetch(() => ({
      status: 200,
      json: completion(JSON.stringify({ category: "database", confidence: "high" }), {
        reasoning_content: "step by step…",
      }),
    }));
    const client = makeClient(fetch, sink);
    await client.generateStructured({ ctx, model: "default", schema: Classification, messages });

    const [call] = await raw`SELECT reasoning_artifact_id FROM model_calls
                             WHERE attempt_id = ${ctx.attemptId}`;
    const [artifact] = await raw`SELECT type, created_by FROM artifacts
                                 WHERE id = ${call?.reasoning_artifact_id}`;
    expect(artifact).toMatchObject({ type: "reasoning", created_by: "test-agent" });
    const back = await store.read(call?.reasoning_artifact_id as string, db);
    expect(back.content.toString()).toBe("step by step…");
  });
});

describe("generateText", () => {
  it("returns text and persists the call", async () => {
    const { fetch } = stubFetch(() => ({ status: 200, json: completion("plain answer") }));
    const client = makeClient(fetch);
    const res = await client.generateText({ ctx, model: "default", messages });
    expect(res.text).toBe("plain answer");
    const rows = await raw`SELECT * FROM model_calls WHERE attempt_id = ${ctx.attemptId}`;
    expect(rows).toHaveLength(1);
  });
});
