// Ticket 4.4 acceptance: the decision interpreter against real Postgres —
// every decision × the cycle guard, plus the analyze-accept → evaluate-task
// chain. The Evaluator only ever returned JSON; everything asserted here is
// Control Plane state (ADR-003, ADR-016).
import {
  createDb,
  deleteRun,
  type EvaluationCandidate,
  seedAttempt,
  seedCanonicalClaim,
  seedRawClaim,
  seedRun,
  seedTask,
  updateAttemptInput,
  updateAttemptOutput,
} from "@lab/db";
import { type AnalysisOutput, type EvaluatorOutput, newId } from "@lab/schemas";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { acceptAnalysisAttempt } from "./analysis";
import { applyEvaluatorDecision } from "./evaluation";

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

const VERDICT: EvaluatorOutput = {
  issues: [
    {
      severity: "high",
      category: "missing_evidence",
      description: "one facet uncovered",
      suggestedResearchQuestion: null,
    },
  ],
  decision: "RESEARCH_MORE",
  reasons: ["a facet of the question has no evidence"],
  requiredActions: [
    {
      kind: "research",
      question: "How does PostgreSQL handle DDL inside prepared transactions?",
      seedUrls: ["https://www.postgresql.org/docs/current/sql-prepare-transaction.html"],
      rationale: "uncovered facet",
    },
  ],
  acceptedUncertainties: [],
  criterionVerdicts: [],
};

async function seedEvaluatingRun(output: EvaluatorOutput, runStatus = "EVALUATING") {
  const runId = newId();
  const taskId = newId();
  const attemptId = newId();
  cleanup.push(runId);
  await seedRun(db, runId, "evaluation interpreter test");
  await db.execute(sql`UPDATE research_runs SET status = ${runStatus} WHERE id = ${runId}`);
  await db.execute(sql`
    INSERT INTO plan_stages (id, run_id, stage, spec_version, delta, rationale)
    VALUES (${newId()}, ${runId}, 1, 1, '{}'::jsonb, 's1')`);
  await seedTask(db, {
    id: taskId,
    runId,
    status: "EVALUATING",
    type: "evaluate",
    title: "judge",
  });
  await seedAttempt(db, { id: attemptId, taskId, runId, status: "SUCCEEDED" });
  await updateAttemptInput(db, attemptId, { coverage: { evidenceCount: 7 } });
  await updateAttemptOutput(db, attemptId, output);
  const candidate: EvaluationCandidate = {
    taskId,
    runId,
    taskType: "evaluate",
    strategy: null,
    attemptCount: 1,
    maxAttempts: 3,
    attemptId,
    attemptStatus: "SUCCEEDED",
    attemptNumber: 1,
    error: null,
    attemptCompletedAt: null,
    infraFailureCount: 0,
  };
  return { runId, taskId, attemptId, candidate };
}

async function runStatus(runId: string): Promise<string> {
  const rows = await db.execute(sql`SELECT status FROM research_runs WHERE id = ${runId}`);
  return String([...rows][0]?.status);
}

describe("applyEvaluatorDecision", () => {
  it("ACCEPT → synthesize task enqueued, run SYNTHESIZING; verdict persisted with the coverage the model saw", async () => {
    const { runId, taskId, candidate, attemptId } = await seedEvaluatingRun({
      ...VERDICT,
      decision: "ACCEPT",
      requiredActions: [],
      issues: [],
      acceptedUncertainties: ["community reports not exhaustively sampled"],
    });
    const result = await applyEvaluatorDecision(db, candidate, 3, 3);
    // 5.1 (phase-5-plan D4): completion belongs to synthesis now.
    expect(result.outcome).toBe("synthesis_enqueued");
    expect(result.createdTaskIds).toHaveLength(1);
    expect(await runStatus(runId)).toBe("SYNTHESIZING");
    const tasks = [
      ...(await db.execute(sql`
        SELECT id, status, agent_role, input FROM research_tasks
        WHERE run_id = ${runId} AND type = 'synthesize'`)),
    ];
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.agent_role).toBe("synthesizer");
    const taskInput = tasks[0]?.input as Record<string, unknown>;
    expect(taskInput.cycle).toBe(1);
    expect(typeof taskInput.evaluationId).toBe("string"); // concrete input (ADR-011)
    const deps = [
      ...(await db.execute(sql`
        SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ${tasks[0]?.id}`)),
    ];
    expect(deps.map((d) => d.depends_on_task_id)).toContain(taskId);
    const evals = [
      ...(await db.execute(sql`
        SELECT decision, metadata FROM evaluations
        WHERE run_id = ${runId} AND evaluator_name = 'evaluator/v1'`)),
    ];
    expect(evals).toHaveLength(1);
    expect(evals[0]?.decision).toBe("ACCEPT");
    const meta = evals[0]?.metadata as Record<string, unknown>;
    expect((meta.coverage as Record<string, unknown>).evidenceCount).toBe(7); // verbatim (R13)
    expect(meta.cycle).toBe(1);
    void attemptId;
  });

  it("RESEARCH_MORE → one concrete follow-up task per action, current stage, run loops back", async () => {
    const { runId, candidate } = await seedEvaluatingRun(VERDICT);
    const result = await applyEvaluatorDecision(db, candidate, 3, 3);
    expect(result.outcome).toBe("followups_created");
    expect(result.createdTaskIds).toHaveLength(1);
    const tasks = [
      ...(await db.execute(sql`
        SELECT type, title, status, priority, plan_stage, input FROM research_tasks
        WHERE run_id = ${runId} AND type = 'research'`)),
    ];
    expect(tasks).toHaveLength(1);
    const input = tasks[0]?.input as Record<string, unknown>;
    expect(input.researchQuestion).toContain("prepared transactions");
    expect(input.seedUrls).toHaveLength(1);
    expect(tasks[0]?.plan_stage).toBe(1); // no new stage (design §14)
    expect(tasks[0]?.priority).toBe(80);
    expect(await runStatus(runId)).toBe("RESEARCHING");
    const beats = [
      ...(await db.execute(
        sql`SELECT type FROM events WHERE run_id = ${runId} AND type = 'FOLLOWUP_TASK_CREATED'`,
      )),
    ];
    expect(beats).toHaveLength(1);
  });

  it("cycle guard (ADR-016): cap reached → WAITING_HUMAN + checkpoint, demand NOT interpreted", async () => {
    const { runId, candidate } = await seedEvaluatingRun(VERDICT);
    const result = await applyEvaluatorDecision(db, candidate, 3, 1); // cap = 1
    expect(result.outcome).toBe("cycle_guard");
    expect(await runStatus(runId)).toBe("WAITING_HUMAN");
    const tasks = [
      ...(await db.execute(
        sql`SELECT id FROM research_tasks WHERE run_id = ${runId} AND type = 'research'`,
      )),
    ];
    expect(tasks).toHaveLength(0); // the RESEARCH_MORE demand was NOT executed
    const cp = [
      ...(await db.execute(sql`SELECT reason FROM human_checkpoints WHERE run_id = ${runId}`)),
    ];
    expect(cp[0]?.reason).toBe("cycle_guard");
    const trip = [
      ...(await db.execute(
        sql`SELECT kind FROM events WHERE run_id = ${runId} AND type = 'CYCLE_GUARD_TRIPPED'`,
      )),
    ];
    expect(trip[0]?.kind).toBe("fail");
  });

  it("ESCALATE → WAITING_HUMAN with evaluator_escalation checkpoint", async () => {
    const { runId, candidate } = await seedEvaluatingRun({
      ...VERDICT,
      decision: "ESCALATE",
      requiredActions: [],
    });
    const result = await applyEvaluatorDecision(db, candidate, 3, 3);
    expect(result.outcome).toBe("waiting_human");
    expect(await runStatus(runId)).toBe("WAITING_HUMAN");
    const cp = [
      ...(await db.execute(sql`SELECT reason FROM human_checkpoints WHERE run_id = ${runId}`)),
    ];
    expect(cp[0]?.reason).toBe("evaluator_escalation");
  });

  it("REPLAN → plan task for the next stage carrying evaluatorFeedback", async () => {
    const { runId, candidate } = await seedEvaluatingRun({ ...VERDICT, decision: "REPLAN" });
    const result = await applyEvaluatorDecision(db, candidate, 3, 3);
    expect(result.outcome).toBe("replanned");
    const plans = [
      ...(await db.execute(sql`
        SELECT plan_stage, input FROM research_tasks
        WHERE run_id = ${runId} AND type = 'plan'`)),
    ];
    expect(plans).toHaveLength(1);
    expect(plans[0]?.plan_stage).toBe(2);
    const input = plans[0]?.input as Record<string, unknown>;
    expect((input.evaluatorFeedback as Record<string, unknown>).decision).toBe("REPLAN");
    expect(await runStatus(runId)).toBe("RESEARCHING");
  });

  it("fake evaluate task (no EvaluatorOutput) accepts plainly — phase-1 machinery unaffected", async () => {
    const { runId, candidate, attemptId } = await seedEvaluatingRun(VERDICT);
    await updateAttemptOutput(db, attemptId, { fakeResult: true } as unknown as EvaluatorOutput);
    const result = await applyEvaluatorDecision(db, candidate, 3, 3);
    expect(result.outcome).toBe("skipped");
    expect(await runStatus(runId)).toBe("EVALUATING"); // no walk
  });
});

describe("acceptAnalysisAttempt", () => {
  it("accepting an analysis creates the evaluate task in the same tx and advances the run", async () => {
    const runId = newId();
    const taskId = newId();
    const attemptId = newId();
    cleanup.push(runId);
    await seedRun(db, runId, "analysis accept test");
    await db.execute(sql`UPDATE research_runs SET status = 'ANALYZING' WHERE id = ${runId}`);
    // A live claim for the citation to point at.
    const researchTask = newId();
    const researchAttempt = newId();
    await seedTask(db, { id: researchTask, runId, status: "DONE", title: "r" });
    await seedAttempt(db, { id: researchAttempt, taskId: researchTask, runId });
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
      taskId: researchTask,
      attemptId: researchAttempt,
      canonicalClaimId: claimId,
      subjectKey: "s",
      predicateKey: "p",
    });
    await seedTask(db, { id: taskId, runId, status: "EVALUATING", type: "analyze", title: "a" });
    await seedAttempt(db, { id: attemptId, taskId, runId, status: "SUCCEEDED" });
    const analysis: AnalysisOutput = {
      findings: [{ statement: "f", canonicalClaimIds: [claimId], implication: null }],
      comparisons: [],
      unresolvedQuestions: [],
      confidenceNote: "ok",
    };
    await updateAttemptOutput(db, attemptId, analysis);

    const result = await acceptAnalysisAttempt(db, {
      taskId,
      runId,
      taskType: "analyze",
      strategy: null,
      attemptCount: 1,
      maxAttempts: 3,
      attemptId,
      attemptStatus: "SUCCEEDED",
      attemptNumber: 1,
      error: null,
      attemptCompletedAt: null,
      infraFailureCount: 0,
    });
    expect(result.evaluateTaskId).not.toBeNull();
    const evalTasks = [
      ...(await db.execute(sql`
        SELECT status, agent_role FROM research_tasks WHERE run_id = ${runId} AND type = 'evaluate'`)),
    ];
    expect(evalTasks).toHaveLength(1);
    expect(evalTasks[0]?.agent_role).toBe("evaluator");
    const status = await db.execute(sql`SELECT status FROM research_runs WHERE id = ${runId}`);
    expect([...status][0]?.status).toBe("EVALUATING");
    const beats = [
      ...(await db.execute(sql`
        SELECT type FROM events WHERE run_id = ${runId}
        AND type IN ('ANALYSIS_ACCEPTED','EVALUATE_TASK_CREATED')`)),
    ];
    expect(beats).toHaveLength(2);
  });
});
