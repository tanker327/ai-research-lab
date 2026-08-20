// Ticket 5.1 acceptance: synthesis is the run's finish line. Accepting a
// synthesize attempt completes the run in one tx; a failed/cancelled
// synthesize task parks/re-enqueues via sweepRunCompletion — completion never
// belongs to the sweep once the loop owns the run.
import {
  createDb,
  deleteRun,
  type EvaluationCandidate,
  insertPlanStage,
  seedAttempt,
  seedCanonicalClaim,
  seedClaimEvidenceLink,
  seedEvidence,
  seedRawClaim,
  seedRun,
  seedTask,
  updateAttemptOutput,
} from "@lab/db";
import { newId, type SynthesizerOutput } from "@lab/schemas";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { sweepEvaluations } from "./scheduler/evaluate";
import { sweepRunCompletion } from "./scheduler/run";
import { acceptSynthesisAttempt } from "./synthesis";

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

const REPORT: SynthesizerOutput = {
  title: "Findings",
  reportMarkdown: "The claim holds. [c1]\n\n## Uncertainties\n- thin sample",
  citationMap: { c1: ["claim-1"] },
};

async function seedSynthesizingRun(output: unknown, runStatus = "SYNTHESIZING") {
  const runId = newId();
  const taskId = newId();
  const attemptId = newId();
  cleanup.push(runId);
  await seedRun(db, runId, "synthesis accept test");
  await db.execute(sql`UPDATE research_runs SET status = ${runStatus} WHERE id = ${runId}`);
  await seedTask(db, {
    id: taskId,
    runId,
    status: "EVALUATING",
    type: "synthesize",
    title: "Synthesize report",
  });
  await seedAttempt(db, { id: attemptId, taskId, runId, status: "SUCCEEDED" });
  await updateAttemptOutput(db, attemptId, output as Record<string, unknown>);
  const candidate: EvaluationCandidate = {
    taskId,
    runId,
    taskType: "synthesize",
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

async function runStatusOf(runId: string): Promise<string> {
  const rows = await db.execute(sql`SELECT status FROM research_runs WHERE id = ${runId}`);
  return String([...rows][0]?.status);
}

async function eventTypes(runId: string): Promise<string[]> {
  const rows = await db.execute(
    sql`SELECT type FROM events WHERE run_id = ${runId} ORDER BY created_at`,
  );
  return [...rows].map((r) => String(r.type));
}

describe("acceptSynthesisAttempt", () => {
  it("real report → attempt ACCEPTED, REPORT_ACCEPTED (gate), run COMPLETED in one tx", async () => {
    const { runId, attemptId, candidate } = await seedSynthesizingRun(REPORT);
    const res = await acceptSynthesisAttempt(db, candidate);
    expect(res).toEqual({ completed: true, hasReport: true });
    expect(await runStatusOf(runId)).toBe("COMPLETED");
    const attempt = [
      ...(await db.execute(sql`SELECT status FROM attempts WHERE id = ${attemptId}`)),
    ];
    expect(attempt[0]?.status).toBe("ACCEPTED");
    const events = await eventTypes(runId);
    expect(events).toContain("REPORT_ACCEPTED");
    expect(events).toContain("RUN_COMPLETED");
    const gate = [
      ...(await db.execute(
        sql`SELECT kind, payload FROM events WHERE run_id = ${runId} AND type = 'REPORT_ACCEPTED'`,
      )),
    ];
    expect(gate[0]?.kind).toBe("gate");
    expect((gate[0]?.payload as Record<string, unknown> | undefined)?.chips).toBe(1);
  });

  it("fake-handler output (no SynthesizerOutput) → REPORT_SKIPPED, run still completes", async () => {
    const { runId, candidate } = await seedSynthesizingRun({ fakeResult: true });
    const res = await acceptSynthesisAttempt(db, candidate);
    expect(res).toEqual({ completed: true, hasReport: false });
    expect(await runStatusOf(runId)).toBe("COMPLETED");
    expect(await eventTypes(runId)).toContain("REPORT_SKIPPED");
  });

  it("run not in SYNTHESIZING (legacy) → accepts the attempt but never walks the run", async () => {
    const { runId, candidate } = await seedSynthesizingRun(REPORT, "RESEARCHING");
    const res = await acceptSynthesisAttempt(db, candidate);
    expect(res).toEqual({ completed: false, hasReport: true });
    expect(await runStatusOf(runId)).toBe("RESEARCHING");
  });
});

describe("sweepRunCompletion — synthesize endgame (5.1)", () => {
  async function seedLoopRun(synthesizeStatus: string) {
    const runId = newId();
    const researchTask = newId();
    const attemptId = newId();
    cleanup.push(runId);
    await seedRun(db, runId, "synthesize endgame test");
    await db.execute(sql`UPDATE research_runs SET status = 'SYNTHESIZING' WHERE id = ${runId}`);
    await insertPlanStage(db, {
      id: newId(),
      runId,
      stage: 2, // stage cap reached — the staged driver stays quiet
      specVersion: 1,
      delta: {},
      rationale: "s2",
    });
    await seedTask(db, {
      id: researchTask,
      runId,
      status: "DONE",
      type: "research",
      title: "d1",
    });
    await seedAttempt(db, { id: attemptId, taskId: researchTask, runId, status: "ACCEPTED" });
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
      attemptId,
      canonicalClaimId: claimId,
      subjectKey: "s",
      predicateKey: "p",
    });
    // The loop history: analysis + evaluation done, synthesis in the state
    // under test.
    await seedTask(db, { id: newId(), runId, status: "DONE", type: "analyze", title: "a" });
    await seedTask(db, { id: newId(), runId, status: "DONE", type: "evaluate", title: "e" });
    await seedTask(db, {
      id: newId(),
      runId,
      status: synthesizeStatus,
      type: "synthesize",
      title: "Synthesize report",
    });
    return runId;
  }

  it("synthesize FAILED → synthesis_failed checkpoint + WAITING_HUMAN, never silent FAILED", async () => {
    const runId = await seedLoopRun("FAILED");
    const result = await sweepRunCompletion(db);
    expect(result.waiting).toContain(runId);
    expect(await runStatusOf(runId)).toBe("WAITING_HUMAN");
    const cp = [
      ...(await db.execute(
        sql`SELECT reason, status FROM human_checkpoints WHERE run_id = ${runId}`,
      )),
    ];
    expect(cp[0]).toMatchObject({ reason: "synthesis_failed", status: "pending" });
  });

  it("synthesize CANCELLED → a fresh synthesize task is re-enqueued; sweep never completes the run", async () => {
    const runId = await sweepReEnqueueSeed();
    const result = await sweepRunCompletion(db);
    expect(result.completed).not.toContain(runId);
    const tasks = [
      ...(await db.execute(sql`
        SELECT status FROM research_tasks
        WHERE run_id = ${runId} AND type = 'synthesize' ORDER BY created_at`)),
    ];
    expect(tasks).toHaveLength(2);
    expect(tasks[1]?.status).toBe("CREATED");
    expect(await runStatusOf(runId)).toBe("SYNTHESIZING");
    // Idempotent: a pending synthesize task means later sweeps stay quiet.
    await sweepRunCompletion(db);
    const after = [
      ...(await db.execute(
        sql`SELECT id FROM research_tasks WHERE run_id = ${runId} AND type = 'synthesize'`,
      )),
    ];
    expect(after).toHaveLength(2);
  });

  async function sweepReEnqueueSeed() {
    return seedLoopRun("CANCELLED");
  }
});

describe("citation validator gates synthesis in the sweep (5.2, ADR-020)", () => {
  async function seedWithClaim(reportMarkdown: string, citationMap: Record<string, string[]>) {
    const seeded = await seedSynthesizingRun({
      title: "Report",
      reportMarkdown,
      citationMap,
    } satisfies SynthesizerOutput);
    // Liveness matters: the claim/evidence must hang off an ACCEPTED research
    // attempt — the synthesize attempt itself is only SUCCEEDED.
    const researchTask = newId();
    const researchAttempt = newId();
    await seedTask(db, {
      id: researchTask,
      runId: seeded.runId,
      status: "DONE",
      type: "research",
      title: "d1",
    });
    await seedAttempt(db, {
      id: researchAttempt,
      taskId: researchTask,
      runId: seeded.runId,
      status: "ACCEPTED",
    });
    const claimId = newId();
    const evidenceId = newId();
    await seedCanonicalClaim(db, {
      id: claimId,
      runId: seeded.runId,
      subjectKey: "s",
      predicateKey: "p",
      statement: "x",
    });
    await seedEvidence(db, {
      id: evidenceId,
      runId: seeded.runId,
      taskId: researchTask,
      attemptId: researchAttempt,
      excerpt: "supporting excerpt",
      sourceClass: "official_docs",
      sourceUrl: "https://example.com",
    });
    await seedClaimEvidenceLink(db, { canonicalClaimId: claimId, evidenceId });
    await seedRawClaim(db, {
      id: newId(),
      runId: seeded.runId,
      taskId: researchTask,
      attemptId: researchAttempt,
      canonicalClaimId: claimId,
      subjectKey: "s",
      predicateKey: "p",
    });
    return { ...seeded, claimId };
  }

  it("doctored draft (uncited sentence + unknown claim id) → REJECTED onto the quality ladder", async () => {
    const { runId, taskId, attemptId } = await seedWithClaim(
      "This sentence is uncited.\n\nThis cites a ghost. [c1]",
      { c1: ["not-a-claim"] },
    );
    const result = await sweepEvaluations(db);
    expect(result.retried).toContain(taskId);
    const attempt = [
      ...(await db.execute(sql`SELECT status FROM attempts WHERE id = ${attemptId}`)),
    ];
    expect(attempt[0]?.status).toBe("REJECTED");
    const task = [
      ...(await db.execute(sql`SELECT status FROM research_tasks WHERE id = ${taskId}`)),
    ];
    expect(task[0]?.status).toBe("READY"); // attempt 1 of 3 — ladder retries
    expect(await runStatusOf(runId)).toBe("SYNTHESIZING"); // never completed
    const checks = [
      ...(await db.execute(sql`
        SELECT evaluator_name FROM evaluations
        WHERE run_id = ${runId} AND decision = 'REJECT' ORDER BY evaluator_name`)),
    ].map((r) => String(r.evaluator_name));
    expect(checks).toContain("check:uncited_sentences");
    expect(checks).toContain("check:chips_cite_live_claims");
  });

  it("fully cited draft → accepted, run COMPLETED via the sweep", async () => {
    const { runId, taskId, claimId } = await seedWithClaim("placeholder", { c1: ["x"] });
    // Rewrite the output now that the claim id exists.
    await db.execute(sql`
      UPDATE attempts SET output = ${JSON.stringify({
        title: "Report",
        reportMarkdown: "The claim holds. [c1]",
        citationMap: { c1: [claimId] },
      })}::jsonb
      WHERE task_id = ${taskId}`);
    const result = await sweepEvaluations(db);
    expect(result.accepted).toContain(taskId);
    expect(await runStatusOf(runId)).toBe("COMPLETED");
  });
});
