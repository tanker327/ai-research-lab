// Staged-planning driver (3.7): when a run's work is done and the last plan
// stage produced live claims, the completion sweep enqueues the next plan
// task instead of completing — up to maxPlanStages.
import {
  createDb,
  deleteRun,
  insertPlanStage,
  seedAttempt,
  seedCanonicalClaim,
  seedRawClaim,
  seedRun,
  seedTask,
} from "@lab/db";
import { newId } from "@lab/schemas";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { sweepRunCompletion } from "./run";

const url = process.env.DATABASE_URL ?? "postgres://lab:lab@localhost:5434/research_lab";
const { db, close } = createDb(url);

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

async function seedStageOneRun(withClaim: boolean) {
  const runId = newId();
  const taskId = newId();
  const attemptId = newId();
  cleanup.push(runId);
  await seedRun(db, runId, "stage driver test");
  await db.execute(sql`UPDATE research_runs SET status = 'RESEARCHING' WHERE id = ${runId}`);
  await seedTask(db, { id: taskId, runId, status: "DONE", type: "research", title: "d1" });
  await seedAttempt(db, { id: attemptId, taskId, runId, status: "ACCEPTED" });
  await insertPlanStage(db, {
    id: newId(),
    runId,
    stage: 1,
    specVersion: 1,
    delta: {},
    rationale: "stage 1",
  });
  if (withClaim) {
    const claimId = newId();
    await seedCanonicalClaim(db, {
      id: claimId,
      runId,
      subjectKey: "s",
      predicateKey: "p",
      statement: "x",
    });
    await seedRawClaim(db, {
      id: newId(),
      runId,
      taskId,
      attemptId,
      canonicalClaimId: claimId,
      subjectKey: "s",
      predicateKey: "p",
    });
  }
  return { runId, taskId };
}

async function taskRows(runId: string) {
  return [
    ...(await db.execute(sql`
    SELECT type, title, status, input FROM research_tasks WHERE run_id = ${runId}
    ORDER BY created_at`)),
  ] as Record<string, unknown>[];
}

describe("staged-planning driver in sweepRunCompletion", () => {
  it("enqueues plan stage 2 instead of completing when stage-1 claims exist", async () => {
    const { runId } = await seedStageOneRun(true);
    const first = await sweepRunCompletion(db);
    expect(first.completed).not.toContain(runId);

    const tasks = await taskRows(runId);
    const plan2 = tasks.find((t) => t.type === "plan");
    expect(plan2).toBeDefined();
    expect((plan2?.input as Record<string, unknown> | undefined)?.planStage).toBe(2);
    expect(plan2?.status).toBe("CREATED");
    // Idempotent: a second sweep does not enqueue another stage-2 task.
    await sweepRunCompletion(db);
    expect((await taskRows(runId)).filter((t) => t.type === "plan")).toHaveLength(1);

    // Once the stage-2 plan task is DONE too (and stage 2 recorded), the cap
    // stops the loop and the run completes.
    const planTask = await taskRows(runId);
    const planId = (planTask.find((t) => t.type === "plan") as { id?: string }).id;
    await db.execute(
      sql`UPDATE research_tasks SET status = 'DONE' WHERE type = 'plan' AND run_id = ${runId}`,
    );
    await insertPlanStage(db, {
      id: newId(),
      runId,
      stage: 2,
      specVersion: 1,
      delta: {},
      rationale: "stage 2",
    });
    const second = await sweepRunCompletion(db);
    expect(second.completed).toContain(runId);
    void planId;
  });

  it("failed leaf + live claims → run completes DEGRADED, not FAILED (ADR-010)", async () => {
    const { runId } = await seedStageOneRun(true);
    await seedTask(db, {
      id: newId(),
      runId,
      status: "FAILED",
      type: "research",
      title: "hard question",
    });
    // stage cap reached so the driver doesn't fire
    await insertPlanStage(db, {
      id: newId(),
      runId,
      stage: 2,
      specVersion: 1,
      delta: {},
      rationale: "stage 2",
    });
    const result = await sweepRunCompletion(db);
    expect(result.completed).toContain(runId);
    const events = [
      ...(await db.execute(
        sql`SELECT kind FROM events WHERE run_id = ${runId} AND type = 'RUN_DEGRADED'`,
      )),
    ];
    expect(events[0]?.kind).toBe("warn");
  });

  it("no live claims after stage 1 → run just completes (nothing to plan against)", async () => {
    const { runId } = await seedStageOneRun(false);
    const result = await sweepRunCompletion(db);
    expect(result.completed).toContain(runId);
    const tasks = await taskRows(runId);
    expect(tasks.filter((t) => t.type === "plan")).toHaveLength(0);
  });
});
