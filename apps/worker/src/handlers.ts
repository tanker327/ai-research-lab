// Handler registry, keyed by task type. Tasks whose input carries `fake` run
// the Phase-1 fake executor (demo chains, concurrency tests, gate:p1); real
// dispatch (implementation-plan §5.5) starts with the Planner (ticket 3.2) —
// Researcher/Extractor land with 3.3/3.4. A handler either returns (attempt
// SUCCEEDED) or throws a CategorizedError (attempt FAILED with that category).
import {
  analystV1,
  evaluatorV1,
  extractorV1,
  plannerV1,
  researcherV1,
  synthesizerV1,
} from "@lab/agents";
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
  type AnalysisOutput,
  CategorizedError,
  FakeTaskInput,
  ModelTier,
  newId,
  PlannerInput,
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

function tierModes(config: Config) {
  return { frontier: config.FRONTIER_STRUCTURED_MODE };
}

// 4.5: an intelligence-retry escalation writes model_tier onto the task row;
// the next attempt routes there (guardDarkFrontier still applies on top).
// Belt (gate finding): only tiers with a configured model are honored — an
// unconfigured suggestion (cheap_remote) is inert, not fatal.
function taskTierOverride(deps: AgentDeps, work: ClaimedWork): ModelTier | null {
  const parsed = ModelTier.safeParse(work.task.modelTier);
  if (!parsed.success) return null;
  return parsed.data in tierModels(deps.config) ? parsed.data : null;
}

// The per-attempt AgentContext (§5.5): tools scoped to the role, artifact
// saves bound to the attempt — agents never hold a db handle (ADR-003).
function agentContext(
  deps: AgentDeps,
  db: Db,
  work: ClaimedWork,
  role: "planner" | "researcher" | "extractor" | "analyst" | "evaluator" | "synthesizer",
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
    searchAvailable: deps.config.FIRECRAWL_BASE_URL !== undefined,
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
  role: "planner" | "researcher" | "extractor" | "analyst" | "evaluator" | "synthesizer",
  route: ReturnType<typeof resolveRoute>,
): Promise<ReturnType<typeof resolveRoute>> {
  if (route.tier !== "frontier" || deps.config.FRONTIER_ENABLED === 1) return route;
  const downgraded = resolveRoute(
    role,
    work.attempt.attemptNumber,
    tierModels(deps.config),
    "strong_local",
    tierModes(deps.config),
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
    const taskInput = (work.task.input ?? {}) as Record<string, unknown>;
    const stage = Number(taskInput.planStage ?? 1);
    // REPLAN stages carry the evaluator's verdict (4.4) — validated into the
    // slim feedback shape; anything else is ignored.
    const feedback = PlannerInput.shape.evaluatorFeedback.safeParse(taskInput.evaluatorFeedback);
    const input = await deps.context.forPlanner(
      work.task.runId,
      stage,
      feedback.success ? feedback.data : undefined,
    );
    await updateAttemptInput(db, work.attempt.id, input); // R12: verbatim

    const route = await guardDarkFrontier(
      deps,
      db,
      work,
      "planner",
      resolveRoute(
        "planner",
        work.attempt.attemptNumber,
        tierModels(deps.config),
        deps.config.PLANNER_TIER,
        tierModes(deps.config),
      ),
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
      resolveRoute(
        "researcher",
        work.attempt.attemptNumber,
        tierModels(deps.config),
        taskTierOverride(deps, work),
        tierModes(deps.config),
      ),
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

    const route = resolveRoute(
      "extractor",
      work.attempt.attemptNumber,
      tierModels(deps.config),
      taskTierOverride(deps, work),
      tierModes(deps.config),
    );
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

function analystHandler(deps: AgentDeps): TaskHandler {
  return async (db, work) => {
    const input = await deps.context.forAnalyst(work.task.runId);
    await updateAttemptInput(db, work.attempt.id, input); // R12: verbatim

    const route = await guardDarkFrontier(
      deps,
      db,
      work,
      "analyst",
      resolveRoute(
        "analyst",
        work.attempt.attemptNumber,
        tierModels(deps.config),
        taskTierOverride(deps, work),
        tierModes(deps.config),
      ),
    );
    const ctx = agentContext(deps, db, work, "analyst", route);
    const output = analystV1.outputSchema.parse(await analystV1.run(input, ctx));

    // Human-readable memo alongside the structured output (design §6.4) —
    // what the console and (P5) the Synthesizer's context render.
    await ctx.saveArtifact({
      type: "analysis_memo",
      name: "analysis-memo.md",
      mediaType: "text/markdown",
      content: renderAnalysisMemo(output),
      createdBy: "analyst/v1",
    });
    await updateAttemptOutput(db, work.attempt.id, output);
  };
}

function renderAnalysisMemo(a: AnalysisOutput): string {
  const cite = (ids: string[]) => ids.map((id) => `[${id.slice(0, 8)}]`).join("");
  return [
    "## Findings",
    ...a.findings.map(
      (f) =>
        `- ${f.statement} ${cite(f.canonicalClaimIds)}${f.implication ? `\n  → ${f.implication}` : ""}`,
    ),
    ...(a.comparisons.length
      ? [
          "\n## Comparisons",
          ...a.comparisons.map(
            (c) => `- **${c.topic}**: ${c.statement} ${cite(c.canonicalClaimIds)}`,
          ),
        ]
      : []),
    ...(a.unresolvedQuestions.length
      ? ["\n## Unresolved questions", ...a.unresolvedQuestions.map((q) => `- ${q}`)]
      : []),
    `\n## Confidence\n${a.confidenceNote}`,
  ].join("\n");
}

function evaluatorHandler(deps: AgentDeps): TaskHandler {
  return async (db, work) => {
    const input = await deps.context.forEvaluator(
      work.task.runId,
      deps.config.DEFAULT_MAX_EVAL_CYCLES,
    );
    await updateAttemptInput(db, work.attempt.id, input); // R12: verbatim — incl. coverage

    const route = await guardDarkFrontier(
      deps,
      db,
      work,
      "evaluator",
      resolveRoute(
        "evaluator",
        work.attempt.attemptNumber,
        tierModels(deps.config),
        taskTierOverride(deps, work),
        tierModes(deps.config),
      ),
    );
    const output = evaluatorV1.outputSchema.parse(
      await evaluatorV1.run(input, agentContext(deps, db, work, "evaluator", route)),
    );
    await updateAttemptOutput(db, work.attempt.id, output);
  };
}

// 5.1: one frontier call, NO tools (§18 — the synthesizer cannot import
// uncited facts; nothing here ever hands it the tool registry). The report
// markdown is persisted as the run's `report` artifact; the citationMap rides
// the attempt output for the validator (5.2) and the citations API (5.3).
function synthesizerHandler(deps: AgentDeps): TaskHandler {
  return async (db, work) => {
    const input = await deps.context.forSynthesizer(work.task.runId);
    await updateAttemptInput(db, work.attempt.id, input); // R12: verbatim

    const route = await guardDarkFrontier(
      deps,
      db,
      work,
      "synthesizer",
      resolveRoute(
        "synthesizer",
        work.attempt.attemptNumber,
        tierModels(deps.config),
        taskTierOverride(deps, work),
        tierModes(deps.config),
      ),
    );
    const ctx = agentContext(deps, db, work, "synthesizer", route);
    const output = synthesizerV1.outputSchema.parse(await synthesizerV1.run(input, ctx));

    await ctx.saveArtifact({
      type: "report",
      name: "report.md",
      mediaType: "text/markdown",
      content: output.reportMarkdown,
      createdBy: "synthesizer/v1",
    });
    await updateAttemptOutput(db, work.attempt.id, output);
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
    analyze: withFakeEscape(analystHandler(deps)),
    evaluate: withFakeEscape(evaluatorHandler(deps)),
    synthesize: withFakeEscape(synthesizerHandler(deps)),
    human_review: withFakeEscape(notYetImplemented("human_review", "4.x")),
  };
}
