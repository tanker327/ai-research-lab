// Phase-1 fake handler registry, keyed by task type (phase-1-plan 1.2). Every
// type maps to the fake executor until Phase 2 introduces agent dispatch; the
// registry shape is the part that survives. A handler either returns (attempt
// SUCCEEDED) or throws a CategorizedError (attempt FAILED with that category).
import type { ClaimedWork } from "@lab/core";
import { type Db, insertFakeEvidence } from "@lab/db";
import { CategorizedError, FakeTaskInput, newId, type TaskType } from "@lab/schemas";

export type TaskHandler = (db: Db, work: ClaimedWork) => Promise<void>;

// Portable (vitest runs handlers under Node; the worker runs under Bun).
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fakeHandler(db: Db, work: ClaimedWork): Promise<void> {
  const parsed = FakeTaskInput.safeParse(work.task.input ?? {});
  if (!parsed.success) {
    throw new CategorizedError("SCHEMA_FAILURE", "fake task input failed validation", {
      detail: parsed.error.issues,
    });
  }
  const fake = parsed.data.fake;
  switch (fake.behavior) {
    case "sleep":
      await sleep(fake.ms);
      return;
    case "fail":
      throw new CategorizedError(fake.category, fake.message);
    case "side_effect":
      await insertFakeEvidence(db, {
        id: newId(),
        runId: work.task.runId,
        taskId: work.task.id,
        attemptId: work.attempt.id,
        excerpt: fake.excerpt,
      });
      if (fake.sleepMs > 0) await sleep(fake.sleepMs);
      return;
  }
}

export function createHandlerRegistry(): Record<TaskType, TaskHandler> {
  return {
    plan: fakeHandler,
    research: fakeHandler,
    extract: fakeHandler,
    analyze: fakeHandler,
    evaluate: fakeHandler,
    synthesize: fakeHandler,
    human_review: fakeHandler,
  };
}
