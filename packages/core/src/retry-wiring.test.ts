// Ticket 4.5 acceptance: the intelligence ladder is WIRED, not just decided —
// a deterministic reject writes the fallback strategy / escalated tier onto
// the task row, so the next claim actually runs differently (rule 10 end to
// end). Uses the real sweep path against real Postgres.
import { createDb, deleteRun, seedAttempt, seedRun, seedTask, updateAttemptOutput } from "@lab/db";
import { newId, type ResearcherOutput } from "@lab/schemas";
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

// A researcher output that fails check:self_assessment deterministically.
const THIN_OUTPUT: ResearcherOutput = {
  noteArtifactId: "01a0-note",
  sourcesVisited: [],
  selfAssessment: { complete: false, confidence: "low", gaps: ["found nothing"] },
};

async function seedRejectableResearch(attemptNumber: number, strategy: string) {
  const runId = newId();
  const taskId = newId();
  const attemptId = newId();
  cleanup.push(runId);
  await seedRun(db, runId, "retry wiring");
  await db.execute(sql`UPDATE research_runs SET status = 'RESEARCHING' WHERE id = ${runId}`);
  await seedTask(db, {
    id: taskId,
    runId,
    status: "EVALUATING",
    type: "research",
    title: "q",
    strategy,
  });
  await db.execute(
    sql`UPDATE research_tasks SET attempt_count = ${attemptNumber} WHERE id = ${taskId}`,
  );
  await seedAttempt(db, {
    id: attemptId,
    taskId,
    runId,
    attemptNumber,
    status: "SUCCEEDED",
  });
  await updateAttemptOutput(db, attemptId, THIN_OUTPUT);
  return { runId, taskId };
}

async function taskRow(taskId: string) {
  const rows = await db.execute(
    sql`SELECT status, strategy, model_tier FROM research_tasks WHERE id = ${taskId}`,
  );
  return [...rows][0] as { status: string; strategy: string | null; model_tier: string | null };
}

describe("intelligence-retry wiring (deterministic reject → ladder → applied directives)", () => {
  it("attempt 1 rejected → task READY with the FALLBACK strategy written on the row", async () => {
    const { taskId } = await seedRejectableResearch(1, "comparative");
    await sweepEvaluations(db);
    const t = await taskRow(taskId);
    expect(t.status).toBe("READY");
    expect(t.strategy).toBe("primary_sources"); // STRATEGY_FALLBACK applied, not just recorded
    expect(t.model_tier).toBeNull();
  });

  it("attempt 2 rejected → task READY with model_tier=frontier (escalation applied)", async () => {
    const { taskId } = await seedRejectableResearch(2, "primary_sources");
    await sweepEvaluations(db);
    const t = await taskRow(taskId);
    expect(t.status).toBe("READY");
    expect(t.model_tier).toBe("frontier");
  });

  it("attempt 3 rejected → ladder exhausted, task FAILED, no directives", async () => {
    const { taskId } = await seedRejectableResearch(3, "primary_sources");
    await sweepEvaluations(db);
    const t = await taskRow(taskId);
    expect(t.status).toBe("FAILED");
  });
});

describe("infra casualties do not consume the cap on the quality path (P7 cap fix wiring)", () => {
  it("a quality reject at the raw cap survives when an infra casualty pads the count", async () => {
    // maxAttempts=2; attempt 1 was a TRANSIENT_INFRA casualty (dead worker),
    // attempt 2 is quality-rejected. Raw count (2) hits the cap, but only ONE
    // intelligence attempt ran — the ladder's tier escalation must survive.
    const runId = newId();
    const taskId = newId();
    cleanup.push(runId);
    await seedRun(db, runId, "cap wiring");
    await db.execute(sql`UPDATE research_runs SET status = 'RESEARCHING' WHERE id = ${runId}`);
    await seedTask(db, {
      id: taskId,
      runId,
      status: "EVALUATING",
      type: "research",
      title: "q",
      strategy: "broad_discovery",
      maxAttempts: 2,
    });
    await db.execute(sql`UPDATE research_tasks SET attempt_count = 2 WHERE id = ${taskId}`);
    await seedAttempt(db, {
      id: newId(),
      taskId,
      runId,
      attemptNumber: 1,
      status: "FAILED",
      error: { category: "TRANSIENT_INFRA", message: "worker SIGTERMed mid-claim" },
    });
    const judged = newId();
    await seedAttempt(db, { id: judged, taskId, runId, attemptNumber: 2, status: "SUCCEEDED" });
    await updateAttemptOutput(db, judged, THIN_OUTPUT);

    const swept = await sweepEvaluations(db);
    expect(swept.retried).toContain(taskId);
    const task = [
      ...(await db.execute(
        sql`SELECT status, model_tier FROM research_tasks WHERE id = ${taskId}`,
      )),
    ];
    // Not FAILED — the casualty was excluded; the attempt-2 verdict (tier
    // escalation) was applied onto the task row (4.5 wiring).
    expect(task[0]?.status).toBe("READY");
    expect(task[0]?.model_tier).toBe("frontier");
  });
});
