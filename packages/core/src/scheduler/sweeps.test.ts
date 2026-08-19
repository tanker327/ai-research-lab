// Ticket 1.3 acceptance against real Postgres: dependency chains become READY
// in waves; failed deps block; expired claims release with the attempt failed
// TRANSIENT_INFRA (matrix row 1 semantics — the SIGKILL process fixture runs
// in the phase gate; here the dead worker is simulated by an unfinished claim).
import { createDb, deleteRun, seedDependency, seedRun, seedTask } from "@lab/db";
import { newId } from "@lab/schemas";
import postgres from "postgres";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimNextReadyTask } from "../claim";
import { sweepReadiness, sweepStaleClaims } from "./sweeps";

const url = process.env.DATABASE_URL ?? "postgres://lab:lab@localhost:5434/research_lab";
const { db, close } = createDb(url);
const raw = postgres(url);

let runId: string;

beforeEach(async () => {
  runId = newId();
  await seedRun(db, runId);
});

// Per-test cleanup: claimNextReadyTask is global by design, so a READY task
// left behind by one test would be claimed by the next one's worker.
afterEach(async () => {
  await deleteRun(db, runId);
});

afterAll(async () => {
  await close();
  await raw.end();
});

const status = async (taskId: string) => {
  const [r] = await raw`SELECT status FROM research_tasks WHERE id = ${taskId}`;
  return r?.status;
};

describe("sweepReadiness", () => {
  it("promotes a dependency chain in waves", async () => {
    const [a, b, c] = [newId(), newId(), newId()];
    for (const id of [a, b, c]) await seedTask(db, { id, runId, status: "CREATED" });
    await seedDependency(db, b, a);
    await seedDependency(db, c, b);

    // Wave 1: only the root is ready.
    expect((await sweepReadiness(db)).ready).toEqual([a]);
    expect(await status(b)).toBe("CREATED");

    // Nothing new while A is unfinished; the sweep is idempotent.
    expect((await sweepReadiness(db)).ready).toEqual([]);

    await raw`UPDATE research_tasks SET status = 'DONE' WHERE id = ${a}`;
    expect((await sweepReadiness(db)).ready).toEqual([b]);
    expect(await status(c)).toBe("CREATED");

    await raw`UPDATE research_tasks SET status = 'DONE' WHERE id = ${b}`;
    expect((await sweepReadiness(db)).ready).toEqual([c]);
  });

  it("requires ALL required deps DONE", async () => {
    const [a, b, c] = [newId(), newId(), newId()];
    for (const id of [a, b, c]) await seedTask(db, { id, runId, status: "CREATED" });
    await seedDependency(db, c, a);
    await seedDependency(db, c, b);
    await raw`UPDATE research_tasks SET status = 'DONE' WHERE id = ${a}`;

    const { ready } = await sweepReadiness(db);
    expect(ready).toContain(b); // b has no deps
    expect(ready).not.toContain(c);
  });

  it("blocks tasks whose required dep FAILED, with a warn event", async () => {
    const [a, b] = [newId(), newId()];
    await seedTask(db, { id: a, runId, status: "FAILED" });
    await seedTask(db, { id: b, runId, status: "CREATED" });
    await seedDependency(db, b, a);

    const { ready, blocked } = await sweepReadiness(db);
    expect(blocked).toEqual([b]);
    expect(ready).toEqual([]);
    expect(await status(b)).toBe("BLOCKED");
    const [event] = await raw`SELECT kind FROM events
                              WHERE task_id = ${b} AND type = 'TASK_BLOCKED'`;
    expect(event?.kind).toBe("warn");
  });

  it("does not promote tasks of a terminal run", async () => {
    const t = newId();
    await seedTask(db, { id: t, runId, status: "CREATED" });
    await raw`UPDATE research_runs SET status = 'CANCELLED' WHERE id = ${runId}`;
    expect((await sweepReadiness(db)).ready).toEqual([]);
    expect(await status(t)).toBe("CREATED");
  });
});

describe("sweepStaleClaims", () => {
  it("releases an expired claim: task READY, attempt FAILED(TRANSIENT_INFRA), warn event", async () => {
    const t = newId();
    await seedTask(db, { id: t, runId });
    const work = await claimNextReadyTask(db, "doomed-worker");
    if (!work) throw new Error("expected claim");
    // The worker \"dies\": age the claim past the timeout instead of waiting.
    await raw`UPDATE research_tasks SET claimed_at = now() - interval '1 hour' WHERE id = ${t}`;

    const released = await sweepStaleClaims(db, 900);
    expect(released).toEqual([t]);

    const [task] = await raw`SELECT status, claimed_by, claimed_at
                             FROM research_tasks WHERE id = ${t}`;
    expect(task).toMatchObject({ status: "READY", claimed_by: null, claimed_at: null });
    const [attempt] = await raw`SELECT status, error FROM attempts WHERE id = ${work.attempt.id}`;
    expect(attempt?.status).toBe("FAILED");
    expect(attempt?.error).toMatchObject({ category: "TRANSIENT_INFRA" });
    const [event] = await raw`SELECT kind FROM events
                              WHERE task_id = ${t} AND type = 'TASK_CLAIM_EXPIRED'`;
    expect(event?.kind).toBe("warn");

    // Re-claim writes a fresh attempt — the dead one's rows stay dark.
    const rerun = await claimNextReadyTask(db, "healthy-worker");
    expect(rerun?.task.id).toBe(t);
    expect(rerun?.attempt.attemptNumber).toBe(2);
  });

  it("leaves fresh claims alone", async () => {
    const t = newId();
    await seedTask(db, { id: t, runId });
    await claimNextReadyTask(db, "alive-worker");
    expect(await sweepStaleClaims(db, 900)).toEqual([]);
    expect(await status(t)).toBe("RUNNING");
  });
});
