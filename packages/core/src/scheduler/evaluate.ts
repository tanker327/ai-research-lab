// Evaluation sweep (ticket 1.7): resolves tasks parked in EVALUATING.
// Phase 1: a SUCCEEDED attempt is auto-accepted (the Evaluator agent replaces
// this verdict in Phase 4 — the *wiring* is what this phase proves); a FAILED
// attempt goes through decideRetry (rule 10) and the verdict is persisted as
// a DecisionRecord before the task moves.
import {
  applyRetryDirectives,
  type Db,
  type EvaluationCandidate,
  insertDecisionRecord,
  insertEvaluation,
  selectAttemptOutput,
  selectEvaluationCandidates,
  selectEvidenceStatsByAttempt,
  selectLiveClaims,
  updateTaskStatus,
} from "@lab/db";
import {
  AnalysisOutput,
  CategorizedError,
  EvaluatorOutput,
  ExtractorOutput,
  newId,
  ResearcherOutput,
  ResearchStrategy,
  TaskType,
} from "@lab/schemas";
import { acceptAnalysisAttempt } from "../analysis";
import {
  analystPreAcceptChecks,
  evaluatorPreAcceptChecks,
  extractorPreAcceptChecks,
  researcherPreAcceptChecks,
} from "../checks";
import { applyEvaluatorDecision } from "../evaluation";
import { emitEvent } from "../events";
import { acceptResearchAttempt } from "../extract";
import { acceptAttempt } from "../liveness";
import { applyAcceptedPlan } from "../plan";
import { rejectSucceededAttempt } from "../quality";
import { decideRetry, enforceAttemptCap, type RetryVerdict } from "../retry";
import { assertTaskTransition } from "../state/task";
import { acceptSynthesisAttempt } from "../synthesis";

const ACTOR = "retry_coordinator";

export interface EvaluationSweepResult {
  accepted: string[];
  retried: string[];
  failed: string[];
  // Last accepted attempt per run this tick — the canonicalization trigger,
  // and the attempt that owns its merge-confirm model calls.
  acceptedRuns: Array<{ runId: string; attemptId: string }>;
}

export async function sweepEvaluations(
  db: Db,
  now = () => new Date(),
  maxAttemptsDefault = 3,
  minEvidence = 3,
  maxEvalCycles = 3,
): Promise<EvaluationSweepResult> {
  const result: EvaluationSweepResult = { accepted: [], retried: [], failed: [], acceptedRuns: [] };
  const candidates = await selectEvaluationCandidates(db);

  for (const c of candidates) {
    if (c.attemptStatus === "SUCCEEDED") {
      // Deterministic pre-accept checks (3.6) — they run only when the output
      // parses as the real agent contract (fake-handler attempts skip), and
      // rejections ride the ordinary retry ladder (rule 10).
      const failures = await preAcceptChecks(db, c, minEvidence);
      const rejects = failures.filter((f) => f.severity === "reject");
      if (rejects.length > 0) {
        const rejection = await db.transaction((tx) =>
          rejectSucceededAttempt(tx, c, rejects, {
            decisionType: "deterministic_check",
            actor: "check_runner",
          }),
        );
        (rejection.verdictKind === "task_failed" ? result.failed : result.retried).push(c.taskId);
        continue;
      }
      // Advisory checks (e.g. the vendor rule in V0.05): visible in the
      // trace, never blocking — the Evaluator weighs them in P4.
      for (const w of failures.filter((f) => f.severity === "warn")) {
        await insertEvaluation(db, {
          id: newId(),
          runId: c.runId,
          targetType: "attempt",
          targetId: c.attemptId,
          evaluatorType: "rule",
          evaluatorName: w.check,
          decision: "WARN",
          reasons: [w.reason],
          metadata: {},
        });
        await emitEvent(db, {
          runId: c.runId,
          taskId: c.taskId,
          attemptId: c.attemptId,
          type: "CHECK_WARNING",
          kind: "warn",
          actor: "check_runner",
          payload: { check: w.check, reason: w.reason },
        });
      }
      // Plan tasks: acceptance and PlanDelta interpretation are one
      // transaction (ticket 3.2, ADR-003/011) — a rejected delta rides the
      // same retry ladder as any other quality rejection.
      if (c.taskType === "plan") {
        const applied = await applyAcceptedPlan(db, c, maxAttemptsDefault);
        (applied.outcome === "applied" ? result.accepted : result.retried).push(c.taskId);
        if (applied.outcome === "applied") recordAcceptedRun(result, c);
        continue;
      }
      // Two-pass research (ADR-012): accepting a research attempt creates its
      // extract task in the same transaction.
      if (c.taskType === "research") {
        await acceptResearchAttempt(db, c, maxAttemptsDefault);
        result.accepted.push(c.taskId);
        recordAcceptedRun(result, c);
        continue;
      }
      // Analysis accept creates the evaluate task in the same tx (4.4);
      // evaluate accept interprets the decision under the ADR-016 guard.
      if (c.taskType === "analyze") {
        await acceptAnalysisAttempt(db, c);
        result.accepted.push(c.taskId);
        recordAcceptedRun(result, c);
        continue;
      }
      if (c.taskType === "evaluate") {
        await applyEvaluatorDecision(db, c, maxAttemptsDefault, maxEvalCycles);
        result.accepted.push(c.taskId);
        recordAcceptedRun(result, c);
        continue;
      }
      // Synthesis accept completes the run in the same tx (5.1); the
      // citation validator (5.2) ran above as a pre-accept check.
      if (c.taskType === "synthesize") {
        await acceptSynthesisAttempt(db, c);
        result.accepted.push(c.taskId);
        recordAcceptedRun(result, c);
        continue;
      }
      await acceptAttempt(db, c.attemptId, ACTOR);
      result.accepted.push(c.taskId);
      recordAcceptedRun(result, c);
      continue;
    }
    if (c.attemptStatus !== "FAILED") continue; // e.g. CANCELLED mid-sweep — not ours

    const verdict = resolveVerdict(c);
    if (verdict.kind === "infra_retry") {
      // Backoff without a delay queue: the task stays EVALUATING until the
      // delay has elapsed, then a later sweep tick releases it.
      const eligibleAt = (c.attemptCompletedAt?.getTime() ?? 0) + verdict.delayMs;
      if (now().getTime() < eligibleAt) continue;
    }

    await db.transaction(async (tx) => {
      const to = verdict.kind === "task_failed" ? "FAILED" : "READY";
      assertTaskTransition("EVALUATING", to);
      await updateTaskStatus(tx, c.taskId, to);
      // 4.5: ladder directives are APPLIED on the failure path too — the
      // SCHEMA_FAILURE attempt-2 frontier escalation writes the tier onto the
      // task row so the next claim actually routes there.
      if (verdict.kind === "intelligence_retry" && (verdict.strategy || verdict.tier)) {
        await applyRetryDirectives(tx, c.taskId, {
          strategy: verdict.strategy,
          modelTier: verdict.tier,
        });
      }
      await insertDecisionRecord(tx, {
        id: newId(),
        runId: c.runId,
        taskId: c.taskId,
        attemptId: c.attemptId,
        type: "retry_ladder",
        decision: verdict.kind,
        rationale: verdict.rationale,
        createdBy: ACTOR,
        metadata:
          verdict.kind === "intelligence_retry"
            ? { strategy: verdict.strategy, tier: verdict.tier }
            : {},
      });
      await emitEvent(tx, {
        runId: c.runId,
        taskId: c.taskId,
        attemptId: c.attemptId,
        type: verdict.kind === "task_failed" ? "TASK_FAILED" : "TASK_RETRY",
        kind: verdict.kind === "task_failed" ? "fail" : "warn",
        actor: ACTOR,
        payload: { decision: verdict.kind, rationale: verdict.rationale },
      });
    });
    (verdict.kind === "task_failed" ? result.failed : result.retried).push(c.taskId);
  }
  return result;
}

async function preAcceptChecks(
  db: Db,
  c: EvaluationCandidate,
  minEvidence: number,
): Promise<ReturnType<typeof researcherPreAcceptChecks>> {
  const checked = ["research", "extract", "analyze", "evaluate"];
  if (!checked.includes(c.taskType)) return [];
  const output = await selectAttemptOutput(db, c.attemptId);
  if (c.taskType === "research") {
    const parsed = ResearcherOutput.safeParse(output);
    return parsed.success ? researcherPreAcceptChecks(parsed.data) : [];
  }
  if (c.taskType === "evaluate") {
    const parsed = EvaluatorOutput.safeParse(output);
    return parsed.success ? evaluatorPreAcceptChecks(parsed.data) : [];
  }
  if (c.taskType === "analyze") {
    const parsed = AnalysisOutput.safeParse(output);
    if (!parsed.success) return [];
    const liveIds = new Set((await selectLiveClaims(db, c.runId)).map((cl) => cl.id));
    return analystPreAcceptChecks(parsed.data, liveIds);
  }
  const parsed = ExtractorOutput.safeParse(output);
  if (!parsed.success) return [];
  const stats = await selectEvidenceStatsByAttempt(db, c.attemptId);
  return extractorPreAcceptChecks(parsed.data, stats, minEvidence);
}

function recordAcceptedRun(result: EvaluationSweepResult, c: EvaluationCandidate): void {
  const existing = result.acceptedRuns.find((r) => r.runId === c.runId);
  if (existing) existing.attemptId = c.attemptId;
  else result.acceptedRuns.push({ runId: c.runId, attemptId: c.attemptId });
}

function resolveVerdict(c: EvaluationCandidate): RetryVerdict {
  const error = c.error
    ? new CategorizedError(c.error.category, c.error.message, { detail: c.error.detail })
    : null;
  const verdict = decideRetry(
    {
      taskType: TaskType.parse(c.taskType),
      attemptNumber: c.attemptNumber,
      // The ladder wants completed infra retries; the failing attempt itself
      // is already counted in the DB aggregate, so step back one.
      infraRetryCount: Math.max(0, c.infraFailureCount - 1),
      strategy: ResearchStrategy.safeParse(c.strategy).data ?? null,
    },
    error,
    null,
  );
  // Attempt budget is a hard cap on top of the ladder (design §8.1 readiness).
  return enforceAttemptCap(verdict, c.attemptCount, c.maxAttempts);
}
