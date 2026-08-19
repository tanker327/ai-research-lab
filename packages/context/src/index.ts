// @lab/context — Context Builder (ticket 3.1, design §12). Determines output
// quality more than agent role design does. All claim/evidence reads go
// through live_* views via @lab/db (rule 5); reasoning artifacts are excluded
// from contexts BY CONSTRUCTION — the builders never select artifacts at all
// (ADR-018, rule 9; asserted by a contract test).
import type { Db } from "@lab/db";
import {
  selectDoneTasksWithOutput,
  selectLatestSpec,
  selectLiveClaimEvidence,
  selectLiveClaims,
  selectRunForContext,
  selectTaskForContext,
} from "@lab/db";
import type { CapabilitySummary, ResearchSpecification } from "@lab/schemas";
import {
  CategorizedError,
  ExtractorInput,
  PlannerInput,
  ResearcherInput,
  ResearchStrategy,
} from "@lab/schemas";
import { DEFAULT_BUDGETS, estimateTokens, fitToBudget, type RoleBudgets } from "./budget";
import {
  DEFAULT_EVIDENCE_K,
  FULL_DIGEST,
  filterClaimsForQuestion,
  renderClaimDigest,
  summarizeDoneTask,
} from "./digest";

export * from "./budget";
export * from "./digest";

export interface ContextBuilder {
  forPlanner(runId: string, stage: number): Promise<PlannerInput>;
  forResearcher(taskId: string): Promise<ResearcherInput>;
  forExtractor(taskId: string): Promise<ExtractorInput>;
}

export interface ContextBuilderDeps {
  db: Db;
  // What the worker can actually offer agents right now (web_search appears
  // here only once SEARXNG_BASE_URL is configured — plan D4).
  capabilities: CapabilitySummary[];
  budgets?: Partial<RoleBudgets>;
  now?: () => Date;
}

// Digest degradation ladder per §12: full → drop context-relation evidence →
// tighten per-claim K → claims only (no excerpts) → empty digest.
function digestLadder(
  claims: Parameters<typeof renderClaimDigest>[0],
  evidence: Parameters<typeof renderClaimDigest>[1],
): Array<{ label: string; value: string; tokens: number }> {
  const variants = [
    { label: "full", opts: FULL_DIGEST },
    {
      label: "no-context-evidence",
      opts: { evidenceK: DEFAULT_EVIDENCE_K, includeContextRelation: false, includeExcerpts: true },
    },
    {
      label: "k1",
      opts: { evidenceK: 1, includeContextRelation: false, includeExcerpts: true },
    },
    {
      label: "claims-only",
      opts: { evidenceK: 0, includeContextRelation: false, includeExcerpts: false },
    },
  ];
  const out = variants.map(({ label, opts }) => {
    const value = renderClaimDigest(claims, evidence, opts);
    return { label, value, tokens: estimateTokens(value) };
  });
  out.push({ label: "empty", value: "", tokens: 0 });
  return out;
}

export function createContextBuilder(deps: ContextBuilderDeps): ContextBuilder {
  const budgets: RoleBudgets = { ...DEFAULT_BUDGETS, ...deps.budgets };
  const now = deps.now ?? (() => new Date());

  return {
    async forPlanner(runId, stage) {
      const run = await selectRunForContext(deps.db, runId);
      if (!run) {
        throw new CategorizedError("PERMANENT_INFRA", `context: run ${runId} not found`);
      }
      const specRow = await selectLatestSpec(deps.db, runId);
      const specification: ResearchSpecification | undefined = specRow ?? undefined;
      const suppliedConstraints = Array.isArray(run.metadata.constraints)
        ? (run.metadata.constraints as string[]).map((c) => String(c).slice(0, 2000)).slice(0, 20)
        : undefined;

      let completedTaskSummaries: PlannerInput["completedTaskSummaries"];
      let liveClaimDigest: string | undefined;
      if (stage >= 2) {
        const done = await selectDoneTasksWithOutput(deps.db, runId);
        completedTaskSummaries = done.map(summarizeDoneTask).slice(0, 100);
        const claims = await selectLiveClaims(deps.db, runId);
        const evidence = await selectLiveClaimEvidence(deps.db, runId);
        const hard =
          estimateTokens(run.userRequest) +
          estimateTokens(JSON.stringify(specification ?? {})) +
          estimateTokens(JSON.stringify(completedTaskSummaries));
        const fit = fitToBudget({
          role: "planner",
          budgetTokens: budgets.planner,
          hardTokens: hard,
          renderings: digestLadder(claims, evidence),
        });
        liveClaimDigest = fit.value === "" ? undefined : fit.value;
      }

      return PlannerInput.parse({
        userRequest: run.userRequest,
        suppliedConstraints,
        specification,
        planStage: stage,
        completedTaskSummaries,
        liveClaimDigest,
        availableCapabilities: deps.capabilities,
      });
    },

    async forResearcher(taskId) {
      const task = await selectTaskForContext(deps.db, taskId);
      if (!task) {
        throw new CategorizedError("PERMANENT_INFRA", `context: task ${taskId} not found`);
      }
      if (task.type !== "research") {
        throw new CategorizedError(
          "PERMANENT_INFRA",
          `context: forResearcher called on ${task.type} task ${taskId}`,
        );
      }
      const input = task.input;
      const question = String(input.researchQuestion ?? input.question ?? task.title);
      const strategy = ResearchStrategy.parse(task.strategy ?? "broad_discovery");

      // Same-subject digest only (design §12): avoid re-collecting what the
      // run already holds, without leaking other tasks' notes.
      const claims = filterClaimsForQuestion(await selectLiveClaims(deps.db, task.runId), question);
      const claimIds = new Set(claims.map((c) => c.id));
      const evidence = (await selectLiveClaimEvidence(deps.db, task.runId)).filter((e) =>
        claimIds.has(e.canonicalClaimId),
      );
      const hard = estimateTokens(question) + estimateTokens(JSON.stringify(task.successCriteria));
      const fit = fitToBudget({
        role: "researcher",
        budgetTokens: budgets.researcher,
        hardTokens: hard,
        renderings: digestLadder(claims, evidence),
      });

      const date = now().toISOString().slice(0, 10);
      return ResearcherInput.parse({
        question,
        strategy,
        successCriteria: task.successCriteria,
        liveEvidenceDigest: fit.value === "" ? undefined : fit.value,
        excludedSources: Array.isArray(input.excludedSources)
          ? (input.excludedSources as string[])
          : undefined,
        seedUrls: Array.isArray(input.seedUrls) ? (input.seedUrls as string[]) : undefined,
        timeContext: `Current date: ${date}. Prefer sources current as of this date; note publication dates.`,
      });
    },

    // The extract task's input was written fully concrete by the Control
    // Plane at research-accept (ADR-011, plan D5) — validate, don't query.
    async forExtractor(taskId) {
      const task = await selectTaskForContext(deps.db, taskId);
      if (!task) {
        throw new CategorizedError("PERMANENT_INFRA", `context: task ${taskId} not found`);
      }
      const parsed = ExtractorInput.safeParse(task.input);
      if (!parsed.success) {
        throw new CategorizedError(
          "SCHEMA_FAILURE",
          `context: extract task ${taskId} input is not a concrete ExtractorInput — staged-planning invariant violated (ADR-011)`,
          { detail: parsed.error.issues },
        );
      }
      return parsed.data;
    },
  };
}
