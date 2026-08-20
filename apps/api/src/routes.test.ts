// Ticket 1.8 acceptance: route tests via Hono app.request against real
// Postgres — create, read, events, cancel, and the validation/error edges.
import { createArtifactStore, createDb, deleteRun, seedAttempt, seedRun, seedTask } from "@lab/db";
import { newId } from "@lab/schemas";
import { pino } from "pino";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import type { EventBus } from "./event-bus";

const url = process.env.DATABASE_URL ?? "postgres://lab:lab@localhost:5434/research_lab";
const { db, close } = createDb(url);
// Routes under test never wake on events — a no-op bus keeps the test hermetic.
const bus: EventBus = { subscribe: () => () => {}, stop: async () => {} };
const artifacts = createArtifactStore(process.env.ARTIFACT_ROOT ?? "./data/artifacts-test");
const app = createApp({ db, bus, log: pino({ level: "silent" }), artifacts });

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

describe("Phase 3 console surface (3.7)", () => {
  it("POST /runs without tasks seeds a planner-driven stage-1 plan task", async () => {
    const res = await app.request("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userRequest: "compare local coding models" }),
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    cleanup.push(id);
    const tasks = (await (await app.request(`/runs/${id}/tasks`)).json()) as Array<{
      type: string;
      title: string;
    }>;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ type: "plan", title: "Plan · stage 1" });
  });

  it("GET /runs/:id/claims serves live canonical claims (empty for a fresh run)", async () => {
    const id = await createRun();
    const claims = (await (await app.request(`/runs/${id}/claims`)).json()) as unknown[];
    expect(claims).toEqual([]);
  });
});

describe("Phase 5 read surface (5.3)", () => {
  async function seedReportedRun() {
    const runId = newId();
    const taskId = newId();
    const attemptId = newId();
    cleanup.push(runId);
    await seedRun(db, runId, "report surface test");
    await seedTask(db, {
      id: taskId,
      runId,
      status: "DONE",
      type: "synthesize",
      title: "Synthesize report",
    });
    await seedAttempt(db, {
      id: attemptId,
      taskId,
      runId,
      status: "ACCEPTED",
      output: {
        title: "The Report",
        reportMarkdown: "The claim holds. [c1]",
        citationMap: { c1: [newId()] },
      },
    });
    await artifacts.save(db, {
      id: newId(),
      runId,
      taskId,
      attemptId,
      type: "report",
      name: "report.md",
      content: "# The Report\n\nThe claim holds. [c1]",
      createdBy: "synthesizer/v1",
    });
    return { runId, taskId, attemptId };
  }

  it("GET /runs/:id/report serves title, markdown from the artifact, and the citationMap", async () => {
    const { runId, attemptId } = await seedReportedRun();
    const res = await app.request(`/runs/${runId}/report`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.attemptId).toBe(attemptId);
    expect(body.title).toBe("The Report");
    expect(String(body.markdown)).toContain("# The Report");
    expect(Object.keys(body.citationMap as Record<string, unknown>)).toEqual(["c1"]);
  });

  it("GET /runs/:id/report 404s before any synthesis is accepted", async () => {
    const runId = newId();
    cleanup.push(runId);
    await seedRun(db, runId, "no report yet");
    expect((await app.request(`/runs/${runId}/report`)).status).toBe(404);
  });

  it("GET /runs/:id/report/citations resolves chips to claims (unknown ids resolve null)", async () => {
    const { runId } = await seedReportedRun();
    const res = await app.request(`/runs/${runId}/report/citations`);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{
      chip: string;
      claims: Array<{ statement: unknown }>;
    }>;
    expect(rows[0]?.chip).toBe("c1");
    expect(rows[0]?.claims[0]?.statement).toBeNull(); // id not a live claim here
  });

  it("GET trace + transcript serve the §24.2 block sequence in staged order", async () => {
    const { runId, attemptId } = await seedReportedRun();
    const trace = (await (
      await app.request(`/runs/${runId}/attempts/${attemptId}/trace`)
    ).json()) as { attempt: { id: string }; blocks: Array<{ kind: string }> };
    expect(trace.attempt.id).toBe(attemptId);
    const kinds = trace.blocks.map((b) => b.kind);
    expect(kinds[0]).toBe("context_in");
    expect(kinds).toContain("output");
    const transcript = (await (await app.request(`/runs/${runId}/transcript`)).json()) as {
      stage: number;
      traces: Array<{ attempt: { id: string } }>;
    };
    expect(transcript.traces.map((t) => t.attempt.id)).toContain(attemptId);
    // A wrong-run trace lookup 404s (no cross-run leakage).
    const otherRun = newId();
    cleanup.push(otherRun);
    await seedRun(db, otherRun, "other");
    expect((await app.request(`/runs/${otherRun}/attempts/${attemptId}/trace`)).status).toBe(404);
  });
});

describe("Phase 6 read surface (6.2)", () => {
  it("GET /runs/:id/metrics aggregates the dashboard in one call", async () => {
    const runId = newId();
    const taskId = newId();
    cleanup.push(runId);
    await seedRun(db, runId, "metrics test");
    await seedTask(db, { id: taskId, runId, status: "DONE", type: "research", title: "r" });
    await seedTask(db, { id: newId(), runId, status: "FAILED", type: "analyze", title: "a" });
    await seedAttempt(db, { id: newId(), taskId, runId, status: "ACCEPTED" });
    const res = await app.request(`/runs/${runId}/metrics`);
    expect(res.status).toBe(200);
    const m = (await res.json()) as Record<string, number>;
    expect(m).toMatchObject({
      tasksTotal: 2,
      tasksDone: 1,
      tasksFailed: 1,
      tasksResearch: 1,
      tasksControl: 1,
      attemptsTotal: 1,
      liveEvidence: 0,
      evalCycles: 0,
      maxEvalCycles: 3,
    });
    expect(m.wallClockSeconds).toBeGreaterThanOrEqual(0);
  });
});
