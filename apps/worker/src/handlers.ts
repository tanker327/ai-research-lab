// Handler registry, keyed by task type. Tasks whose input carries `fake` run
// the Phase-1 fake executor (demo chains, concurrency tests, gate:p1); real
// dispatch (implementation-plan §5.5) starts with the Planner (ticket 3.2) —
// Researcher/Extractor land with 3.3/3.4. A handler either returns (attempt
// SUCCEEDED) or throws a CategorizedError (attempt FAILED with that category).
import { plannerV1 } from "@lab/agents";
import type { ContextBuilder } from "@lab/context";
import { type ClaimedWork, type Config, emitEvent } from "@lab/core";
import {
  type ArtifactStore,
  type Db,
  insertFakeEvidence,
  updateAttemptInput,
  updateAttemptOutput,
} from "@lab/db";
import { type ModelClient, resolveRoute } from "@lab/model";
import { CategorizedError, FakeTaskInput, newId, type TaskType } from "@lab/schemas";
import type { createToolRegistry } from "@lab/tools";

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

export interface AgentDeps {
  config: Config;
  model: ModelClient;
  tools: ReturnType<typeof createToolRegistry>;
  artifacts: ArtifactStore;
  context: ContextBuilder;
}

function plannerHandler(deps: AgentDeps): TaskHandler {
  return async (db, work) => {
    const stage = Number((work.task.input as Record<string, unknown>)?.planStage ?? 1);
    const input = await deps.context.forPlanner(work.task.runId, stage);
    await updateAttemptInput(db, work.attempt.id, input); // R12: verbatim

    const models = {
      frontier: deps.config.MODEL_FRONTIER,
      strong_local: deps.config.MODEL_STRONG_LOCAL,
      fast_local: deps.config.MODEL_FAST_LOCAL,
    };
    const route = resolveRoute(
      "planner",
      work.attempt.attemptNumber,
      models,
      deps.config.PLANNER_TIER,
    );
    if (route.tier !== "frontier") {
      // D3: loud, never silent — the console timeline shows the downgrade.
      await emitEvent(db, {
        runId: work.task.runId,
        taskId: work.task.id,
        attemptId: work.attempt.id,
        type: "PLANNER_TIER_DOWNGRADED",
        kind: "warn",
        actor: "worker",
        payload: { tier: route.tier, reason: "hub frontier keys pending (phase-3-plan D3)" },
      });
    }

    const output = await plannerV1.run(input, {
      runId: work.task.runId,
      taskId: work.task.id,
      attemptId: work.attempt.id,
      attemptNumber: work.attempt.attemptNumber,
      model: deps.model,
      route,
      tools: deps.tools.forAttempt({
        runId: work.task.runId,
        taskId: work.task.id,
        attemptId: work.attempt.id,
        role: "planner",
      }),
      artifacts: deps.artifacts,
      signal: new AbortController().signal,
    });
    const valid = plannerV1.outputSchema.safeParse(output);
    if (!valid.success) {
      throw new CategorizedError("SCHEMA_FAILURE", "planner output failed schema validation", {
        detail: valid.error.issues,
      });
    }
    await updateAttemptOutput(db, work.attempt.id, valid.data);
  };
}

function notYetImplemented(type: string, ticket: string): TaskHandler {
  return async () => {
    throw new CategorizedError(
      "PERMANENT_INFRA",
      `no real handler for task type '${type}' yet — arrives with ticket ${ticket}`,
    );
  };
}

// Fake inputs always take the fake path (Phase-1 machinery stays exercised);
// everything else dispatches to the real agent for its type.
function withFakeEscape(real: TaskHandler): TaskHandler {
  return (db, work) => {
    const input = (work.task.input ?? {}) as Record<string, unknown>;
    if (input.fake !== undefined) return fakeHandler(db, work);
    return real(db, work);
  };
}

export function createHandlerRegistry(deps?: AgentDeps): Record<TaskType, TaskHandler> {
  if (!deps) {
    // Test/gate mode: everything fake (phase-1 behavior).
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
  return {
    plan: withFakeEscape(plannerHandler(deps)),
    research: withFakeEscape(notYetImplemented("research", "3.3")),
    extract: withFakeEscape(notYetImplemented("extract", "3.4")),
    analyze: withFakeEscape(notYetImplemented("analyze", "4.x")),
    evaluate: withFakeEscape(notYetImplemented("evaluate", "4.x")),
    synthesize: withFakeEscape(notYetImplemented("synthesize", "5.x")),
    human_review: withFakeEscape(notYetImplemented("human_review", "4.x")),
  };
}
