// Ticket 3.4 acceptance (control-plane half): accepting a research attempt
// creates the extract task in the same transaction with fully concrete input
// (ADR-011/ADR-012); non-researcher outputs (fake handler era) skip loudly.
import { createDb, deleteRun, seedAttempt, seedRun, seedTask } from "@lab/db";
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

async function seedResearchCandidate(output: unknown) {
  const runId = newId();
  const taskId = newId();
  const attemptId = newId();
  cleanup.push(runId);
  await seedRun(db, runId, "extract enqueue test");
  await seedTask(db, {
    id: taskId,
    runId,
    status: "EVALUATING",
    type: "research",
    title: "quantization research",
    priority: 70,
    input: { researchQuestion: "What quantizations does qwen3.6-27b support?" },
  });
  await seedAttempt(db, {
    id: attemptId,
    taskId,
    runId,
    status: "SUCCEEDED",
    output: output as Record<string, unknown>,
  });
  return { runId, taskId, attemptId };
}

describe("acceptResearchAttempt via sweepEvaluations", () => {
  it("creates the extract task atomically with concrete ExtractorInput", async () => {
    const noteId = newId();
    const output: ResearcherOutput = {
      noteArtifactId: noteId,
      sourcesVisited: [{ url: "https://docs.example.com", retrievedAt: "2026-08-19T00:00:00Z" }],
      selfAssessment: { complete: true, confidence: "high", gaps: [] },
    };
    const { runId, taskId } = await seedResearchCandidate(output);
    const result = await sweepEvaluations(db);
    expect(result.accepted).toContain(taskId);

    const rows = [
      ...(await db.execute(sql`
      SELECT id, type, agent_role, priority, input, status FROM research_tasks
      WHERE run_id = ${runId} AND type = 'extract'`)),
    ];
    expect(rows).toHaveLength(1);
    const extract = rows[0] as Record<string, unknown>;
    expect(extract).toMatchObject({ agent_role: "extractor", priority: 70, status: "CREATED" });
    const input = extract.input as Record<string, unknown>;
    expect(input.noteArtifactId).toBe(noteId);
    expect(input.question).toContain("qwen3.6-27b");
    expect(Array.isArray(input.sourcesVisited)).toBe(true);

    const deps = [
      ...(await db.execute(sql`
      SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ${extract.id as string}`)),
    ];
    expect(deps[0]?.depends_on_task_id).toBe(taskId);
    const events = [
      ...(await db.execute(sql`
      SELECT type FROM events WHERE run_id = ${runId} AND type = 'EXTRACT_TASK_CREATED'`)),
    ];
    expect(events).toHaveLength(1);
  });

  it("fake-handler research output → EXTRACT_SKIPPED event, no extract task", async () => {
    const { runId, taskId } = await seedResearchCandidate(null);
    const result = await sweepEvaluations(db);
    expect(result.accepted).toContain(taskId);
    const rows = [
      ...(await db.execute(sql`
      SELECT count(*)::int AS n FROM research_tasks WHERE run_id = ${runId} AND type = 'extract'`)),
    ];
    expect(rows[0]?.n).toBe(0);
    const events = [
      ...(await db.execute(sql`
      SELECT type FROM events WHERE run_id = ${runId} AND type = 'EXTRACT_SKIPPED'`)),
    ];
    expect(events).toHaveLength(1);
  });
});
