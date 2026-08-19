// Ticket 3.2 acceptance: PlanDelta interpretation through the evaluation
// sweep against real Postgres — atomic accept+interpret, the executable
// ADR-011 concreteness guard, the ADR-016 cycle guard, and the reject path
// riding the ordinary retry ladder (rule 10).
import { createDb, deleteRun, seedAttempt, seedRun, seedTask } from "@lab/db";
import { newId, type PlannerOutput } from "@lab/schemas";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { sweepEvaluations } from "./scheduler/evaluate";

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

const SPEC = {
  objective: "pick a local coding model",
  scope: ["open-weight models"],
  exclusions: ["closed APIs"],
  constraints: ["fits 24GB VRAM"],
  successCriteria: ["a ranked shortlist"],
  keyQuestions: ["which models fit 24GB?"],
};

function plannerOutput(overrides: Partial<PlannerOutput["planDelta"]> = {}): PlannerOutput {
  return {
    specification: SPEC,
    clarificationsAssumed: ["assumed consumer GPU"],
    planDelta: {
      addTasks: [
        {
          localId: "d1",
          type: "research",
          title: "discover candidate models",
          description: "",
          researchQuestion: "Which open-weight coding models fit in 24GB VRAM as of 2026?",
          strategy: "broad_discovery",
          priority: 80,
          dependencies: [],
          successCriteria: ["at least 5 candidates"],
          parallelizable: true,
          input: {
            researchQuestion: "Which open-weight coding models fit in 24GB VRAM as of 2026?",
          },
        },
        {
          localId: "d2",
          type: "analyze",
          title: "shortlist from discovery",
          description: "",
          priority: 50,
          dependencies: ["d1"],
          successCriteria: [],
          parallelizable: false,
          input: { focus: "vram fit" },
        },
      ],
      cancelTaskIds: [],
      supersedeTaskIds: [],
      rationale: "stage 1: discovery before deep tasks",
      ...overrides,
    },
  };
}

async function seedPlanCandidate(
  output: unknown,
): Promise<{ runId: string; taskId: string; attemptId: string }> {
  const runId = newId();
  const taskId = newId();
  const attemptId = newId();
  cleanup.push(runId);
  await seedRun(db, runId, "plan test");
  await seedTask(db, {
    id: taskId,
    runId,
    status: "EVALUATING",
    type: "plan",
    title: "plan stage 1",
    input: { planStage: 1 },
  });
  await db.execute(sql`UPDATE research_tasks SET attempt_count = 1 WHERE id = ${taskId}`);
  await seedAttempt(db, {
    id: attemptId,
    taskId,
    runId,
    status: "SUCCEEDED",
    output: output as Record<string, unknown>,
  });
  return { runId, taskId, attemptId };
}

async function rows(query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> {
  return [...(await db.execute(query))] as Record<string, unknown>[];
}

describe("applyAcceptedPlan via sweepEvaluations", () => {
  it("valid delta: accept + spec v1 + plan_stages + concrete tasks with mapped deps, atomically", async () => {
    const { runId, taskId, attemptId } = await seedPlanCandidate(plannerOutput());
    const result = await sweepEvaluations(db);
    expect(result.accepted).toContain(taskId);

    const attempt = await rows(sql`SELECT status FROM attempts WHERE id = ${attemptId}`);
    expect(attempt[0]?.status).toBe("ACCEPTED");
    const spec = await rows(
      sql`SELECT version, objective, clarifications_assumed FROM research_specs WHERE run_id = ${runId}`,
    );
    expect(spec[0]).toMatchObject({ version: 1, objective: SPEC.objective });
    const run = await rows(sql`SELECT spec_version FROM research_runs WHERE id = ${runId}`);
    expect(run[0]?.spec_version).toBe(1);
    const stage = await rows(sql`SELECT stage, rationale FROM plan_stages WHERE run_id = ${runId}`);
    expect(stage[0]).toMatchObject({ stage: 1, rationale: "stage 1: discovery before deep tasks" });

    const tasks = await rows(sql`
      SELECT id, type, title, status, strategy, agent_role, plan_stage, input
      FROM research_tasks WHERE run_id = ${runId} AND id != ${taskId} ORDER BY title`);
    expect(tasks).toHaveLength(2);
    const discovery = tasks.find((t) => t.type === "research");
    const analyze = tasks.find((t) => t.type === "analyze");
    expect(discovery).toMatchObject({
      status: "CREATED",
      agent_role: "researcher",
      strategy: "broad_discovery",
    });
    expect((discovery?.input as Record<string, unknown> | undefined)?.researchQuestion).toContain(
      "24GB",
    );
    const deps = await rows(sql`
      SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ${analyze?.id as string}`);
    expect(deps[0]?.depends_on_task_id).toBe(discovery?.id);

    const events = await rows(sql`
      SELECT type FROM events WHERE run_id = ${runId} AND type = 'TASK_PLANNED'`);
    expect(events).toHaveLength(2);
  });

  it("placeholder input → attempt REJECTED, ladder retries, decision recorded (ADR-011)", async () => {
    const bad = plannerOutput();
    const first = bad.planDelta.addTasks[0];
    if (first) first.input = { researchQuestion: "Investigate {{candidate}} model" };
    const { taskId, attemptId } = await seedPlanCandidate(bad);
    const result = await sweepEvaluations(db);
    expect(result.retried).toContain(taskId);

    const attempt = await rows(sql`SELECT status FROM attempts WHERE id = ${attemptId}`);
    expect(attempt[0]?.status).toBe("REJECTED");
    const task = await rows(sql`SELECT status FROM research_tasks WHERE id = ${taskId}`);
    expect(task[0]?.status).toBe("READY");
    const decisions = await rows(sql`
      SELECT rationale FROM decision_records WHERE task_id = ${taskId} AND type = 'plan_rejection'`);
    expect(String(decisions[0]?.rationale)).toContain("ADR-011");
    // Interpretation was atomic with acceptance — nothing got created.
    const tasks = await rows(sql`
      SELECT count(*)::int AS n FROM research_tasks
      WHERE run_id = (SELECT run_id FROM research_tasks WHERE id = ${taskId}) AND id != ${taskId}`);
    expect(tasks[0]?.n).toBe(0);
  });

  it("dependency cycle → rejected (ADR-016 deterministic guard)", async () => {
    const bad = plannerOutput();
    const [a, b] = bad.planDelta.addTasks;
    if (a && b) {
      a.dependencies = ["d2"];
      b.dependencies = ["d1"];
    }
    const { taskId } = await seedPlanCandidate(bad);
    const result = await sweepEvaluations(db);
    expect(result.retried).toContain(taskId);
    const decisions = await rows(sql`
      SELECT rationale FROM decision_records WHERE task_id = ${taskId}`);
    expect(String(decisions[0]?.rationale)).toContain("cycle");
  });

  it("malformed output → rejected; max_attempts exhausted → task FAILED (cap on the ladder)", async () => {
    const { taskId } = await seedPlanCandidate({ nonsense: true });
    await db.execute(sql`UPDATE research_tasks SET attempt_count = 3 WHERE id = ${taskId}`);
    const result = await sweepEvaluations(db);
    expect(result.retried).toContain(taskId); // counted as non-accepted
    const task = await rows(sql`SELECT status FROM research_tasks WHERE id = ${taskId}`);
    expect(task[0]?.status).toBe("FAILED");
  });

  it("humanQuestions land as pending checkpoints with a gate event", async () => {
    const withQuestion = plannerOutput();
    withQuestion.humanQuestions = [
      { question: "Is a used 3090 acceptable?", whyUnsafeToInfer: "changes the budget constraint" },
    ];
    const { runId } = await seedPlanCandidate(withQuestion);
    await sweepEvaluations(db);
    const cp = await rows(
      sql`SELECT status, question FROM human_checkpoints WHERE run_id = ${runId}`,
    );
    expect(cp[0]?.status).toBe("pending");
    expect(String(cp[0]?.question)).toContain("3090");
    const events = await rows(sql`
      SELECT kind FROM events WHERE run_id = ${runId} AND type = 'HUMAN_QUESTION_RAISED'`);
    expect(events[0]?.kind).toBe("gate");
  });

  it("cancelTaskIds cancels an existing READY task via assertTransition", async () => {
    const victim = newId();
    const output = plannerOutput({ cancelTaskIds: [victim] });
    const { runId, taskId } = await seedPlanCandidate(output);
    await seedTask(db, { id: victim, runId, status: "READY", type: "research", title: "obsolete" });
    const result = await sweepEvaluations(db);
    expect(result.accepted).toContain(taskId);
    const task = await rows(sql`SELECT status FROM research_tasks WHERE id = ${victim}`);
    expect(task[0]?.status).toBe("CANCELLED");
  });
});
