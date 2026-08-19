// Ticket 1.8 acceptance: route tests via Hono app.request against real
// Postgres — create, read, events, cancel, and the validation/error edges.
import { createDb, deleteRun } from "@lab/db";
import { newId } from "@lab/schemas";
import { pino } from "pino";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import type { EventBus } from "./event-bus";

const url = process.env.DATABASE_URL ?? "postgres://lab:lab@localhost:5434/research_lab";
const { db, close } = createDb(url);
// Routes under test never wake on events — a no-op bus keeps the test hermetic.
const bus: EventBus = { subscribe: () => () => {}, stop: async () => {} };
const app = createApp({ db, bus, log: pino({ level: "silent" }) });

const cleanup: string[] = [];
afterEach(async () => {
  while (cleanup.length) {
    const id = cleanup.pop();
    if (id) await deleteRun(db, id);
  }
});
afterAll(async () => {
  await close();
});

async function createRun(): Promise<string> {
  const a = newId();
  const res = await app.request("/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      userRequest: "route test",
      tasks: [
        { id: a, type: "research", title: "root", input: {} },
        { type: "extract", title: "child", input: {}, dependsOn: [a] },
      ],
    }),
  });
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as { id: string };
  cleanup.push(id);
  return id;
}

describe("API surface", () => {
  it("GET /runs lists runs newest-first (console runs view)", async () => {
    const id = await createRun();
    const res = await app.request("/runs");
    expect(res.status).toBe(200);
    const runs = (await res.json()) as Array<{ id: string; status: string }>;
    expect(runs.some((r) => r.id === id)).toBe(true);
  });

  it("POST /runs creates a run and seeds tasks; GET endpoints read it back", async () => {
    const id = await createRun();

    const run = await (await app.request(`/runs/${id}`)).json();
    expect(run).toMatchObject({ id, status: "RESEARCHING", userRequest: "route test" });

    const tasks = (await (await app.request(`/runs/${id}/tasks`)).json()) as unknown[];
    expect(tasks).toHaveLength(2);

    const events = (await (await app.request(`/runs/${id}/events`)).json()) as Array<{
      type: string;
      id: string;
    }>;
    expect(events.map((e) => e.type)).toEqual([
      "RUN_CREATED",
      "RUN_PHASE_CHANGED",
      "RUN_PHASE_CHANGED",
    ]);

    // Cursor pagination on the plain events endpoint too.
    const after = events[0]?.id;
    const rest = (await (
      await app.request(`/runs/${id}/events?after=${after}`)
    ).json()) as unknown[];
    expect(rest).toHaveLength(2);
  });

  it("rejects a malformed create request with 400 and Zod issues", async () => {
    const res = await app.request("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userRequest: "", tasks: [] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { issues: unknown[] };
    expect(body.issues.length).toBeGreaterThan(0);
  });

  it("rejects an unknown task type (enum from @lab/schemas)", async () => {
    const res = await app.request("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        userRequest: "x",
        tasks: [{ type: "hack_the_planet", title: "t", input: {} }],
      }),
    });
    expect(res.status).toBe(400);
  });

  it("serves attempts and their calls for the inspector (2.5)", async () => {
    const id = await createRun();
    const attempts = (await (await app.request(`/runs/${id}/attempts`)).json()) as unknown[];
    expect(Array.isArray(attempts)).toBe(true); // no attempts yet — empty list, not an error
    const calls = (await (await app.request(`/attempts/${newId()}/calls`)).json()) as {
      modelCalls: unknown[];
      toolCalls: unknown[];
    };
    expect(calls).toEqual({ modelCalls: [], toolCalls: [] });
  });

  it("404s on a missing run", async () => {
    expect((await app.request(`/runs/${newId()}`)).status).toBe(404);
    expect((await app.request(`/runs/${newId()}/cancel`, { method: "POST" })).status).toBe(404);
  });

  it("POST /runs/:id/cancel cancels; a second cancel is 409", async () => {
    const id = await createRun();
    const first = await app.request(`/runs/${id}/cancel`, { method: "POST" });
    expect(first.status).toBe(200);
    const run = (await (await app.request(`/runs/${id}`)).json()) as { status: string };
    expect(run.status).toBe("CANCELLED");
    const second = await app.request(`/runs/${id}/cancel`, { method: "POST" });
    expect(second.status).toBe(409);
  });
});
