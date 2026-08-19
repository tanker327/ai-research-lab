// Ticket 1.7 acceptance: evaluation sweep (auto-accept + retry ladder with
// DecisionRecords), run completion walking legal phases, cancellation
// mid-wave (matrix row 10), and the pure guard stubs.
import { createDb, deleteRun } from "@lab/db";
import { CategorizedError, newId } from "@lab/schemas";
import postgres from "postgres";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { claimNextReadyTask, finishAttempt } from "../claim";
import { checkBudgetStub } from "./budget";
import { sweepEvaluations } from "./evaluate";
import { checkCycleGuard } from "./guards";
import { cancelRun, startRun, sweepRunCompletion } from "./run";
import { sweepReadiness } from "./sweeps";

const url = process.env.DATABASE_URL ?? "postgres://lab:lab@localhost:5434/research_lab";
const { db, close } = createDb(url);
const raw = postgres(url);
const cleanup: string[] = [];

afterEach(async () => {
  while (cleanup.length) {
    const id = cleanup.pop();
    if (id) await deleteRun(db, id);
  }
});

afterAll(async () => {
  await close();
  await raw.end();
});

const FUTURE = () => new Date(Date.now() + 10 * 60_000); // past every backoff delay

async function startSimpleRun(tasks: Parameters<typeof startRun>[1]["tasks"]): Promise<string> {
  const runId = await startRun(db, { userRequest: "coordinator test", tasks });
  cleanup.push(runId);
  return runId;
}

describe("startRun", () => {
  it("creates the run, seeds tasks + deps, walks CREATED→RESEARCHING with events", async () => {
    const [a, b] = [newId(), newId()];
    const runId = await startSimpleRun([
      { id: a, type: "research", title: "A", input: {} },
      { id: b, type: "research", title: "B", input: {}, dependsOn: [a] },
    ]);

    const [run] = await raw`SELECT status FROM research_runs WHERE id = ${runId}`;
    expect(run?.status).toBe("RESEARCHING");
    const deps = await raw`SELECT * FROM task_dependencies WHERE task_id = ${b}`;
    expect(deps).toHaveLength(1);
    const events = await raw`SELECT type FROM events WHERE run_id = ${runId} ORDER BY id`;
    expect(events.map((e) => e.type)).toEqual([
      "RUN_CREATED",
      "RUN_PHASE_CHANGED", // CREATED→PLANNING
      "RUN_PHASE_CHANGED", // PLANNING→RESEARCHING
    ]);
  });

  it("emits a budget warning when caps are exceeded (warn-only stub)", async () => {
    const runId = await startSimpleRun([{ id: newId(), type: "research", title: "t", input: {} }]);
    // budget with maxTasks 0 → warning
    const warned = await startRun(db, {
      userRequest: "over budget",
      budget: { maxTasks: 0 },
      tasks: [{ id: newId(), type: "research", title: "t", input: {} }],
    });
    cleanup.push(warned);
    const events = await raw`SELECT type, kind FROM events
                             WHERE run_id = ${warned} AND type = 'BUDGET_WARNING'`;
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("warn");
    expect(runId).toBeTruthy();
  });
});

describe("sweepEvaluations", () => {
  it("auto-accepts a SUCCEEDED attempt (task DONE, evidence flow proven in 1.4)", async () => {
    const t = newId();
    await startSimpleRun([{ id: t, type: "research", title: "t", input: {} }]);
    await sweepReadiness(db);
    const work = await claimNextReadyTask(db, "w");
    if (!work) throw new Error("expected claim");
    await finishAttempt(db, work, { ok: true });

    const result = await sweepEvaluations(db);
    expect(result.accepted).toEqual([t]);
    const [task] = await raw`SELECT status FROM research_tasks WHERE id = ${t}`;
    expect(task?.status).toBe("DONE");
    const [attempt] = await raw`SELECT status FROM attempts WHERE id = ${work.attempt.id}`;
    expect(attempt?.status).toBe("ACCEPTED");
  });

  it("holds an infra-failed task in EVALUATING until the backoff elapses, then retries with a DecisionRecord", async () => {
    const t = newId();
    await startSimpleRun([{ id: t, type: "research", title: "t", input: {} }]);
    await sweepReadiness(db);
    const work = await claimNextReadyTask(db, "w");
    if (!work) throw new Error("expected claim");
    await finishAttempt(db, work, {
      ok: false,
      error: new CategorizedError("TRANSIENT_INFRA", "network blip"),
    });

    // Backoff (5s) has not elapsed — the task stays parked.
    const early = await sweepEvaluations(db);
    expect(early.retried).toEqual([]);
    expect((await raw`SELECT status FROM research_tasks WHERE id = ${t}`)[0]?.status).toBe(
      "EVALUATING",
    );

    // Same sweep with a clock past the delay → READY + decision record.
    const late = await sweepEvaluations(db, FUTURE);
    expect(late.retried).toEqual([t]);
    expect((await raw`SELECT status FROM research_tasks WHERE id = ${t}`)[0]?.status).toBe("READY");
    const [decision] = await raw`SELECT type, decision, rationale, created_by
                                 FROM decision_records WHERE task_id = ${t}`;
    expect(decision).toMatchObject({
      type: "retry_ladder",
      decision: "infra_retry",
      created_by: "retry_coordinator",
    });
    expect(decision?.rationale.length).toBeGreaterThan(20);
  });

  it("fails a task on a non-retryable category with a decision record and fail event", async () => {
    const t = newId();
    await startSimpleRun([{ id: t, type: "research", title: "t", input: {} }]);
    await sweepReadiness(db);
    const work = await claimNextReadyTask(db, "w");
    if (!work) throw new Error("expected claim");
    await finishAttempt(db, work, {
      ok: false,
      error: new CategorizedError("PERMANENT_INFRA", "config is broken"),
    });

    const result = await sweepEvaluations(db);
    expect(result.failed).toEqual([t]);
    expect((await raw`SELECT status FROM research_tasks WHERE id = ${t}`)[0]?.status).toBe(
      "FAILED",
    );
    const [event] =
      await raw`SELECT kind FROM events WHERE task_id = ${t} AND type = 'TASK_FAILED'`;
    expect(event?.kind).toBe("fail");
  });

  it("hard-caps at max_attempts even when the ladder would retry", async () => {
    const t = newId();
    await startSimpleRun([{ id: t, type: "research", title: "t", input: {}, maxAttempts: 1 }]);
    await sweepReadiness(db);
    const work = await claimNextReadyTask(db, "w");
    if (!work) throw new Error("expected claim");
    await finishAttempt(db, work, {
      ok: false,
      error: new CategorizedError("TRANSIENT_INFRA", "would normally retry"),
    });

    const result = await sweepEvaluations(db, FUTURE);
    expect(result.failed).toEqual([t]);
    const [decision] = await raw`SELECT rationale FROM decision_records WHERE task_id = ${t}`;
    expect(decision?.rationale).toContain("max_attempts");
  });
});

describe("sweepRunCompletion", () => {
  it("walks the run to COMPLETED through legal phases when all tasks are DONE", async () => {
    const t = newId();
    const runId = await startSimpleRun([{ id: t, type: "research", title: "t", input: {} }]);
    await sweepReadiness(db);
    const work = await claimNextReadyTask(db, "w");
    if (!work) throw new Error("expected claim");
    await finishAttempt(db, work, { ok: true });
    await sweepEvaluations(db);

    const result = await sweepRunCompletion(db);
    expect(result.completed).toEqual([runId]);
    const [run] = await raw`SELECT status, completed_at FROM research_runs WHERE id = ${runId}`;
    expect(run?.status).toBe("COMPLETED");
    expect(run?.completed_at).not.toBeNull();
    const phases = await raw`SELECT payload FROM events
                             WHERE run_id = ${runId} AND type IN ('RUN_PHASE_CHANGED','RUN_COMPLETED')
                             ORDER BY id`;
    const hops = phases.map((p) => `${p.payload.from}→${p.payload.to}`);
    expect(hops).toEqual([
      "CREATED→PLANNING",
      "PLANNING→RESEARCHING",
      "RESEARCHING→ANALYZING",
      "ANALYZING→EVALUATING",
      "EVALUATING→SYNTHESIZING",
      "SYNTHESIZING→COMPLETED",
    ]);
  });

  it("fails the run when a task is terminally FAILED", async () => {
    const t = newId();
    const runId = await startSimpleRun([
      { id: t, type: "research", title: "t", input: {}, maxAttempts: 1 },
    ]);
    await sweepReadiness(db);
    const work = await claimNextReadyTask(db, "w");
    if (!work) throw new Error("expected claim");
    await finishAttempt(db, work, {
      ok: false,
      error: new CategorizedError("PERMANENT_INFRA", "broken"),
    });
    await sweepEvaluations(db);

    const result = await sweepRunCompletion(db);
    expect(result.failed).toEqual([runId]);
    expect((await raw`SELECT status FROM research_runs WHERE id = ${runId}`)[0]?.status).toBe(
      "FAILED",
    );
  });

  it("leaves runs with in-flight work untouched", async () => {
    const runId = await startSimpleRun([{ id: newId(), type: "research", title: "t", input: {} }]);
    const result = await sweepRunCompletion(db);
    expect(result.completed).not.toContain(runId);
    expect(result.failed).not.toContain(runId);
  });
});

describe("cancelRun (matrix row 10)", () => {
  it("cancels run, pending tasks, and in-flight attempts; a late finishAttempt discards", async () => {
    const [t1, t2] = [newId(), newId()];
    const runId = await startSimpleRun([
      { id: t1, type: "research", title: "running", input: {} },
      { id: t2, type: "research", title: "pending wave 2", input: {}, dependsOn: [t1] },
    ]);
    await sweepReadiness(db);
    const work = await claimNextReadyTask(db, "doomed");
    if (!work) throw new Error("expected claim");

    await cancelRun(db, runId, "test-user");

    const rows = await raw`SELECT id, status FROM research_tasks WHERE run_id = ${runId}`;
    for (const r of rows) expect(r.status).toBe("CANCELLED");
    const [attempt] = await raw`SELECT status FROM attempts WHERE id = ${work.attempt.id}`;
    expect(attempt?.status).toBe("CANCELLED");
    expect((await raw`SELECT status FROM research_runs WHERE id = ${runId}`)[0]?.status).toBe(
      "CANCELLED",
    );

    // The worker comes back with a result for a lost claim — discarded.
    const wrote = await finishAttempt(db, work, { ok: true });
    expect(wrote).toBe(false);
    expect((await raw`SELECT status FROM attempts WHERE id = ${work.attempt.id}`)[0]?.status).toBe(
      "CANCELLED",
    );

    // And the completion sweep never resurrects a cancelled run.
    const result = await sweepRunCompletion(db);
    expect(result.completed).not.toContain(runId);
  });

  it("refuses to cancel a terminal run", async () => {
    const runId = await startSimpleRun([]);
    await raw`UPDATE research_runs SET status = 'COMPLETED' WHERE id = ${runId}`;
    await expect(cancelRun(db, runId)).rejects.toThrow(/Illegal run transition/);
  });
});

describe("guards (pure stubs)", () => {
  it("cycle guard hard-stops at the cap (ADR-016)", () => {
    expect(checkCycleGuard(0, 3).exceeded).toBe(false);
    expect(checkCycleGuard(2, 3).exceeded).toBe(false);
    expect(checkCycleGuard(3, 3).exceeded).toBe(true);
    expect(checkCycleGuard(3, 3).rationale).toContain("hard cap");
  });

  it("budget stub warns without enforcing", () => {
    expect(checkBudgetStub({}, { taskCount: 100 })).toEqual([]);
    const warnings = checkBudgetStub({ maxTasks: 5 }, { taskCount: 6 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("warn-only");
  });
});
