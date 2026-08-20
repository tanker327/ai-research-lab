// Ticket 7.3 acceptance: interactive plan edits against real Postgres —
// legality guards (pending plan_review only, CREATED tasks only), ADR-011
// concreteness on edits, and the audit trail every edit must leave.
import { createDb, deleteRun, insertHumanCheckpoint, seedRun, seedTask } from "@lab/db";
import { CategorizedError, newId } from "@lab/schemas";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { addPlannedTask, editPlannedTask, removePlannedTask, updateRunRouting } from "./plan-edit";

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

async function seedReview(withCheckpoint = true) {
  const runId = newId();
  const taskId = newId();
  cleanup.push(runId);
  await seedRun(db, runId, "plan edit test");
  await db.execute(sql`UPDATE research_runs SET status = 'WAITING_HUMAN' WHERE id = ${runId}`);
  await seedTask(db, {
    id: taskId,
    runId,
    status: "CREATED",
    type: "research",
    title: "original title",
    input: { researchQuestion: "what is the original question here?" },
  });
  if (withCheckpoint) {
    await insertHumanCheckpoint(db, {
      id: newId(),
      runId,
      taskId: null,
      reason: "plan_review",
      question: "review the plan",
    });
  }
  return { runId, taskId };
}

async function rows(q: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> {
  return [...(await db.execute(q))] as Record<string, unknown>[];
}

describe("editPlannedTask", () => {
  it("edits question/title/tier on a CREATED task and leaves the audit trail", async () => {
    const { runId, taskId } = await seedReview();
    await editPlannedTask(
      db,
      runId,
      taskId,
      {
        title: "sharper title",
        researchQuestion: "what does the official documentation actually say?",
        modelTier: "frontier",
        priority: 80,
      },
      "eric",
    );
    const task = await rows(sql`
      SELECT title, priority, model_tier, input FROM research_tasks WHERE id = ${taskId}`);
    expect(task[0]).toMatchObject({ title: "sharper title", priority: 80, model_tier: "frontier" });
    expect((task[0]?.input as Record<string, unknown> | undefined)?.researchQuestion).toContain(
      "official documentation",
    );
    const audit = await rows(sql`
      SELECT decision, created_by FROM decision_records
      WHERE run_id = ${runId} AND type = 'human_plan_edit'`);
    expect(audit[0]).toMatchObject({ decision: "edit", created_by: "eric" });
    const events = await rows(sql`
      SELECT kind FROM events WHERE run_id = ${runId} AND type = 'PLAN_EDITED'`);
    expect(events[0]?.kind).toBe("gate");
  });

  it("rejects placeholder questions (ADR-011) and edits outside a review", async () => {
    const { runId, taskId } = await seedReview();
    await expect(
      editPlannedTask(db, runId, taskId, { researchQuestion: "research the TBD topic please" }),
    ).rejects.toThrow(/placeholder/);

    const noReview = await seedReview(false);
    await expect(
      editPlannedTask(db, noReview.runId, noReview.taskId, { title: "x" }),
    ).rejects.toThrow(/not open for plan editing/);
  });

  it("rejects edits to a task that already started", async () => {
    const { runId, taskId } = await seedReview();
    await db.execute(sql`UPDATE research_tasks SET status = 'READY' WHERE id = ${taskId}`);
    await expect(editPlannedTask(db, runId, taskId, { title: "x" })).rejects.toThrow(
      /only CREATED tasks/,
    );
  });
});

describe("addPlannedTask / removePlannedTask / updateRunRouting", () => {
  it("adds a concrete stage-1 research task with validated dependencies", async () => {
    const { runId, taskId } = await seedReview();
    const newTaskId = await addPlannedTask(
      db,
      runId,
      {
        title: "check community benchmarks",
        researchQuestion: "what do independent community benchmarks report?",
        dependsOn: [taskId],
      },
      "eric",
    );
    const task = await rows(sql`
      SELECT type, status, plan_stage, agent_role, input FROM research_tasks
      WHERE id = ${newTaskId}`);
    expect(task[0]).toMatchObject({
      type: "research",
      status: "CREATED",
      plan_stage: 1,
      agent_role: "researcher",
    });
    const deps = await rows(sql`
      SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ${newTaskId}`);
    expect(deps[0]?.depends_on_task_id).toBe(taskId);

    // Unknown dependency rejects atomically.
    await expect(
      addPlannedTask(db, runId, {
        title: "t",
        researchQuestion: "a perfectly concrete question?",
        dependsOn: [newId()],
      }),
    ).rejects.toThrow(CategorizedError);
  });

  it("removes by retirement (CREATED → CANCELLED), never deletion", async () => {
    const { runId, taskId } = await seedReview();
    await removePlannedTask(db, runId, taskId);
    const task = await rows(sql`SELECT status FROM research_tasks WHERE id = ${taskId}`);
    expect(task[0]?.status).toBe("CANCELLED");
  });

  it("updates the run's roleTiers with an audit row", async () => {
    const { runId } = await seedReview();
    await updateRunRouting(db, runId, { evaluator: "strong_local" }, "eric");
    const run = await rows(sql`SELECT metadata FROM research_runs WHERE id = ${runId}`);
    expect((run[0]?.metadata as Record<string, unknown> | undefined)?.roleTiers).toEqual({
      evaluator: "strong_local",
    });
    const audit = await rows(sql`
      SELECT rationale FROM decision_records
      WHERE run_id = ${runId} AND type = 'human_plan_edit'`);
    expect(String(audit[0]?.rationale)).toContain("routing");
  });
});
