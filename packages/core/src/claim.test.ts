// Ticket 1.2 acceptance against real Postgres (failure-injection matrix row 6):
// SKIP LOCKED claim semantics under real concurrency, attempt lifecycle, and
// the events written alongside every state change.
import { createDb, deleteRun, seedRun, seedTask } from "@lab/db";
import { CategorizedError, newId } from "@lab/schemas";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { claimNextReadyTask, finishAttempt } from "./claim";

const url = process.env.DATABASE_URL ?? "postgres://lab:lab@localhost:5434/research_lab";
// Two clients = two workers with separate connection pools, a real race.
const workerA = createDb(url);
const workerB = createDb(url);
const raw = postgres(url);

const runIds: string[] = [];
let runId: string;

beforeEach(async () => {
  runId = newId();
  runIds.push(runId);
  await seedRun(workerA.db, runId);
});

afterAll(async () => {
  for (const id of runIds) await deleteRun(workerA.db, id);
  await workerA.close();
  await workerB.close();
  await raw.end();
});

describe("claimNextReadyTask", () => {
  it("returns null cheaply when nothing is READY", async () => {
    expect(await claimNextReadyTask(workerA.db, "wA")).toBeNull();
    await seedTask(workerA.db, { id: newId(), runId, status: "CREATED" });
    expect(await claimNextReadyTask(workerA.db, "wA")).toBeNull();
  });

  it("two workers race one READY task — exactly one claim, attempt count 1 (matrix row 6)", async () => {
    for (let round = 0; round < 5; round++) {
      const taskId = newId();
      await seedTask(workerA.db, { id: taskId, runId });

      const [a, b] = await Promise.all([
        claimNextReadyTask(workerA.db, "wA"),
        claimNextReadyTask(workerB.db, "wB"),
      ]);
      const claims = [a, b].filter((c) => c !== null);
      expect(claims).toHaveLength(1);
      const claim = claims[0];
      if (!claim) throw new Error("unreachable");
      expect(claim.task.id).toBe(taskId);
      expect(claim.attempt.attemptNumber).toBe(1);

      const [task] = await raw`
        SELECT status, claimed_by, attempt_count FROM research_tasks WHERE id = ${taskId}`;
      expect(task).toMatchObject({ status: "RUNNING", attempt_count: 1 });
      expect(["wA", "wB"]).toContain(task?.claimed_by);

      const attempts = await raw`SELECT * FROM attempts WHERE task_id = ${taskId}`;
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({ status: "RUNNING", attempt_number: 1 });
    }
  });

  it("claims in priority DESC, created_at ASC order", async () => {
    const low = newId();
    const high = newId();
    await seedTask(workerA.db, { id: low, runId, priority: 10 });
    await seedTask(workerA.db, { id: high, runId, priority: 90 });

    const first = await claimNextReadyTask(workerA.db, "wA");
    const second = await claimNextReadyTask(workerA.db, "wA");
    expect(first?.task.id).toBe(high);
    expect(second?.task.id).toBe(low);
  });

  it("writes a TASK_CLAIMED event in the claim transaction", async () => {
    const taskId = newId();
    await seedTask(workerA.db, { id: taskId, runId });
    const work = await claimNextReadyTask(workerA.db, "wA");

    const events = await raw`
      SELECT type, kind, actor, attempt_id FROM events WHERE task_id = ${taskId}`;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "TASK_CLAIMED",
      kind: "info",
      actor: "wA",
      attempt_id: work?.attempt.id,
    });
  });

  it("re-claim after a release increments attempt_number (fresh attempt, never a re-run row)", async () => {
    const taskId = newId();
    await seedTask(workerA.db, { id: taskId, runId });
    const first = await claimNextReadyTask(workerA.db, "wA");
    if (!first) throw new Error("expected claim");
    await finishAttempt(workerA.db, first, {
      ok: false,
      error: new CategorizedError("TRANSIENT_INFRA", "boom"),
    });
    // Simulate the scheduler putting it back (readiness sweep is ticket 1.3).
    await raw`UPDATE research_tasks SET status = 'READY' WHERE id = ${taskId}`;

    const second = await claimNextReadyTask(workerB.db, "wB");
    expect(second?.task.id).toBe(taskId);
    expect(second?.attempt.attemptNumber).toBe(2);
    const attempts = await raw`
      SELECT attempt_number, status FROM attempts WHERE task_id = ${taskId} ORDER BY attempt_number`;
    expect(attempts).toHaveLength(2);
  });
});

describe("finishAttempt", () => {
  it("success: attempt SUCCEEDED, task EVALUATING, info event", async () => {
    const taskId = newId();
    await seedTask(workerA.db, { id: taskId, runId });
    const work = await claimNextReadyTask(workerA.db, "wA");
    if (!work) throw new Error("expected claim");
    await finishAttempt(workerA.db, work, { ok: true });

    const [attempt] = await raw`SELECT status, error, completed_at FROM attempts
                                WHERE id = ${work.attempt.id}`;
    expect(attempt).toMatchObject({ status: "SUCCEEDED", error: null });
    expect(attempt?.completed_at).not.toBeNull();
    const [task] = await raw`SELECT status FROM research_tasks WHERE id = ${taskId}`;
    expect(task?.status).toBe("EVALUATING");
    const [event] = await raw`SELECT kind FROM events
                              WHERE attempt_id = ${work.attempt.id} AND type = 'ATTEMPT_SUCCEEDED'`;
    expect(event?.kind).toBe("info");
  });

  it("failure: attempt FAILED with the categorized error persisted, fail event", async () => {
    const taskId = newId();
    await seedTask(workerA.db, { id: taskId, runId });
    const work = await claimNextReadyTask(workerA.db, "wA");
    if (!work) throw new Error("expected claim");
    await finishAttempt(workerA.db, work, {
      ok: false,
      error: new CategorizedError("TOOL_FAILURE", "fetch exploded", { detail: { url: "x" } }),
    });

    const [attempt] = await raw`SELECT status, error FROM attempts WHERE id = ${work.attempt.id}`;
    expect(attempt?.status).toBe("FAILED");
    expect(attempt?.error).toMatchObject({ category: "TOOL_FAILURE", message: "fetch exploded" });
    const [event] = await raw`SELECT kind, payload FROM events
                              WHERE attempt_id = ${work.attempt.id} AND type = 'ATTEMPT_FAILED'`;
    expect(event?.kind).toBe("fail");
  });
});
