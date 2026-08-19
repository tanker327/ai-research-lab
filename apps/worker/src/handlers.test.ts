// Direct tests for the fake handler registry — previously covered only
// through the gate. A handler either returns (SUCCEEDED) or throws a
// CategorizedError (FAILED with that category); input is Zod-validated per
// rule 7.
import { createDb, deleteRun, seedRun, seedTask } from "@lab/db";
import { CategorizedError, newId, TaskType } from "@lab/schemas";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createHandlerRegistry } from "./handlers";

const url = process.env.DATABASE_URL ?? "postgres://lab:lab@localhost:5434/research_lab";
const { db, sql, close } = createDb(url);
const registry = createHandlerRegistry();
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

// A minimal ClaimedWork with real FK rows (side_effect writes evidence).
async function seedWork(input: Record<string, unknown>) {
  const runId = newId();
  const taskId = newId();
  const attemptId = newId();
  cleanup.push(runId);
  await seedRun(db, runId);
  await seedTask(db, { id: taskId, runId, status: "RUNNING", input });
  await sql`INSERT INTO attempts (id, task_id, run_id, attempt_number, status, agent_name, agent_version)
            VALUES (${attemptId}, ${taskId}, ${runId}, 1, 'RUNNING', 'fake', 'v1')`;
  return {
    task: {
      id: taskId,
      runId,
      type: "research" as const,
      title: "t",
      priority: 50,
      agentRole: "fake",
      agentVersion: "v1",
      modelTier: null,
      strategy: null,
      input,
      maxAttempts: 3,
      attemptCount: 1,
    },
    attempt: { id: attemptId, attemptNumber: 1 },
  };
}

describe("fake handler registry", () => {
  it("registers a handler for every TaskType", () => {
    for (const type of TaskType.options) expect(registry[type]).toBeTypeOf("function");
  });

  it("sleep behavior completes", async () => {
    const work = await seedWork({ fake: { behavior: "sleep", ms: 5 } });
    await expect(registry.research(db, work)).resolves.toBeUndefined();
  });

  it("empty input defaults to a short sleep (schema default)", async () => {
    const work = await seedWork({});
    await expect(registry.research(db, work)).resolves.toBeUndefined();
  });

  it("fail behavior throws the configured CategorizedError", async () => {
    const work = await seedWork({
      fake: { behavior: "fail", category: "TOOL_FAILURE", message: "boom" },
    });
    const err = await registry.research(db, work).catch((e) => e);
    expect(err).toBeInstanceOf(CategorizedError);
    expect(err).toMatchObject({ category: "TOOL_FAILURE", message: "boom" });
  });

  it("malformed fake input is a SCHEMA_FAILURE (rule 7 — never best-effort)", async () => {
    const work = await seedWork({ fake: { behavior: "explode" } });
    const err = await registry.research(db, work).catch((e) => e);
    expect(err).toBeInstanceOf(CategorizedError);
    expect((err as CategorizedError).category).toBe("SCHEMA_FAILURE");
  });

  it("side_effect writes an evidence row owned by the attempt (rule 5)", async () => {
    const work = await seedWork({ fake: { behavior: "side_effect", excerpt: "handler-test" } });
    await registry.research(db, work);
    const rows =
      await sql`SELECT attempt_id, excerpt FROM evidence WHERE task_id = ${work.task.id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ attempt_id: work.attempt.id, excerpt: "handler-test" });
  });
});
