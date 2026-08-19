// Handler registry, keyed by task type. Tasks whose input carries `fake` run
// the Phase-1 fake executor (demo chains, concurrency tests, gate:p1); real
// dispatch (implementation-plan §5.5) starts with the Planner (ticket 3.2) —
// Researcher/Extractor land with 3.3/3.4. A handler either returns (attempt
// SUCCEEDED) or throws a CategorizedError (attempt FAILED with that category).
import { extractorV1, plannerV1, researcherV1 } from "@lab/agents";
import type { ContextBuilder } from "@lab/context";
import { type ClaimedWork, type Config, emitEvent } from "@lab/core";
import {
  type ArtifactStore,
  type Db,
  insertEvidenceRow,
  insertFakeEvidence,
  insertRawClaimRow,
  selectToolCallsByAttempt,
  updateAttemptInput,
  updateAttemptOutput,
} from "@lab/db";
import { type ModelClient, resolveRoute } from "@lab/model";
import {
  CategorizedError,
  FakeTaskInput,
  newId,
  ResearcherOutput,
  type SourceVisit,
  type TaskType,
} from "@lab/schemas";
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

function tierModels(config: Config) {
  return {
    frontier: config.MODEL_FRONTIER,
    strong_local: config.MODEL_STRONG_LOCAL,
    fast_local: config.MODEL_FAST_LOCAL,
  };
}

// The per-attempt AgentContext (§5.5): tools scoped to the role, artifact
// saves bound to the attempt — agents never hold a db handle (ADR-003).
function agentContext(
  deps: AgentDeps,
  db: Db,
  work: ClaimedWork,
  role: "planner" | "researcher" | "extractor",
  route: ReturnType<typeof resolveRoute>,
) {
  return {
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
      role,
    }),
    saveArtifact: (
      a: Omit<Parameters<ArtifactStore["save"]>[1], "id" | "runId" | "taskId" | "attemptId">,
    ) =>
      deps.artifacts.save(db, {
        ...a,
        id: newId(),
        runId: work.task.runId,
        taskId: work.task.id,
        attemptId: work.attempt.id,
      }),
    readArtifact: async (artifactId: string) => {
      const { content } = await deps.artifacts.read(artifactId, db);
      return content.toString("utf8");
    },
    searchAvailable: deps.config.SEARXNG_BASE_URL !== undefined,
    limits: { maxToolCalls: deps.config.RESEARCHER_MAX_TOOL_CALLS },
    signal: new AbortController().signal,
  };
}

// D3 extension (phase-3-plan finding): while the frontier is dark, any route
// that resolves there is downgraded to strong_local with a warn event —
// loud, never silent (routing policy itself stays untouched).
async function guardDarkFrontier(
  deps: AgentDeps,
  db: Db,
  work: ClaimedWork,
  role: "planner" | "researcher" | "extractor",
  route: ReturnType<typeof resolveRoute>,
): Promise<ReturnType<typeof resolveRoute>> {
  if (route.tier !== "frontier" || deps.config.FRONTIER_ENABLED === 1) return route;
  const downgraded = resolveRoute(
    role,
    work.attempt.attemptNumber,
    tierModels(deps.config),
    "strong_local",
  );
  await emitEvent(db, {
    runId: work.task.runId,
    taskId: work.task.id,
    attemptId: work.attempt.id,
    type: "TIER_DOWNGRADED",
    kind: "warn",
    actor: "worker",
    payload: {
      role,
      from: "frontier",
      to: downgraded.tier,
      reason: "FRONTIER_ENABLED=0 (hub keys pending)",
    },
  });
  return downgraded;
}

function plannerHandler(deps: AgentDeps): TaskHandler {
  return async (db, work) => {
    const stage = Number((work.task.input as Record<string, unknown>)?.planStage ?? 1);
    const input = await deps.context.forPlanner(work.task.runId, stage);
    await updateAttemptInput(db, work.attempt.id, input); // R12: verbatim

    const route = resolveRoute(
      "planner",
      work.attempt.attemptNumber,
      tierModels(deps.config),
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

    const output = await plannerV1.run(input, agentContext(deps, db, work, "planner", route));
    const valid = plannerV1.outputSchema.safeParse(output);
    if (!valid.success) {
      throw new CategorizedError("SCHEMA_FAILURE", "planner output failed schema validation", {
        detail: valid.error.issues,
      });
    }
    await updateAttemptOutput(db, work.attempt.id, valid.data);
  };
}

function researcherHandler(deps: AgentDeps): TaskHandler {
  return async (db, work) => {
    const input = await deps.context.forResearcher(work.task.id);
    await updateAttemptInput(db, work.attempt.id, input); // R12: verbatim

    const route = await guardDarkFrontier(
      deps,
      db,
      work,
      "researcher",
      resolveRoute("researcher", work.attempt.attemptNumber, tierModels(deps.config)),
    );
    const result = await researcherV1.run(input, agentContext(deps, db, work, "researcher", route));

    // sourcesVisited is MECHANICAL: the tool layer's own log (§6.2) — the
    // model cannot forget or invent a URL it fetched.
    const toolCalls = await selectToolCallsByAttempt(db, work.attempt.id);
    const sourcesVisited: SourceVisit[] = toolCalls
      .filter((t) => t.toolName === "web_fetch" && t.error === null)
      .map((t) => ({
        url: String((t.request.input as Record<string, unknown> | undefined)?.url ?? ""),
        retrievedAt: t.createdAt,
        snapshotArtifactId: t.responseArtifactId,
      }))
      .filter((s) => s.url.length > 0)
      .slice(0, 100);

    const output = ResearcherOutput.parse({
      noteArtifactId: result.noteArtifactId,
      sourcesVisited,
      selfAssessment: result.selfAssessment,
    });
    await updateAttemptOutput(db, work.attempt.id, output);
  };
}

function extractorHandler(deps: AgentDeps): TaskHandler {
  return async (db, work) => {
    const input = await deps.context.forExtractor(work.task.id);
    await updateAttemptInput(db, work.attempt.id, input); // R12: verbatim

    const route = resolveRoute("extractor", work.attempt.attemptNumber, tierModels(deps.config));
    const output = extractorV1.outputSchema.parse(
      await extractorV1.run(input, agentContext(deps, db, work, "extractor", route)),
    );

    // Attempt-owned side-effect rows (rule 5, ADR-014) in one transaction:
    // evidence.metadata.rawClaimIds preserves the claim↔evidence mapping for
    // canonicalization's LINK step (3.5) without a schema change.
    await db.transaction(async (tx) => {
      const evidenceIds = output.evidence.map(() => newId());
      const claimIds = output.claims.map(() => newId());
      const claimsByEvidence = new Map<number, string[]>();
      output.claims.forEach((claim, ci) => {
        for (const ref of claim.evidenceRefs) {
          const claimId = claimIds[ci];
          if (claimId === undefined) continue;
          claimsByEvidence.set(ref, [...(claimsByEvidence.get(ref) ?? []), claimId]);
        }
      });
      const snapshotByUrl = new Map(
        input.sourcesVisited.map((s) => [s.url, s.snapshotArtifactId ?? null]),
      );
      for (const [i, e] of output.evidence.entries()) {
        const id = evidenceIds[i];
        if (id === undefined) continue;
        await insertEvidenceRow(tx, {
          id,
          runId: work.task.runId,
          taskId: work.task.id,
          attemptId: work.attempt.id,
          sourceClass: e.sourceClass,
          sourceUrl: e.sourceUrl,
          publisher: e.publisher,
          publishedAt: e.publishedAt,
          vendorAffiliated: e.vendorAffiliated,
          benchmarkOrigin: e.benchmarkOrigin,
          excerpt: e.excerpt,
          artifactId: e.sourceUrl ? (snapshotByUrl.get(e.sourceUrl) ?? null) : null,
          metadata: { rawClaimIds: claimsByEvidence.get(i) ?? [] },
        });
      }
      for (const [i, c] of output.claims.entries()) {
        const id = claimIds[i];
        if (id === undefined) continue;
        await insertRawClaimRow(tx, {
          id,
          runId: work.task.runId,
          taskId: work.task.id,
          attemptId: work.attempt.id,
          statement: c.statement,
          subjectKey: c.subjectKey,
          predicateKey: c.predicateKey,
          valueText: c.valueText,
          type: c.type,
          confidence: c.confidence,
          createdByAgent: "extractor/v1",
        });
      }
      await updateAttemptOutput(tx, work.attempt.id, output);
    });
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
    research: withFakeEscape(researcherHandler(deps)),
    extract: withFakeEscape(extractorHandler(deps)),
    analyze: withFakeEscape(notYetImplemented("analyze", "4.x")),
    evaluate: withFakeEscape(notYetImplemented("evaluate", "4.x")),
    synthesize: withFakeEscape(notYetImplemented("synthesize", "5.x")),
    human_review: withFakeEscape(notYetImplemented("human_review", "4.x")),
  };
}
