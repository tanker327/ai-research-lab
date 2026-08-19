// Evaluation sweep (ticket 1.7): resolves tasks parked in EVALUATING.
// Phase 1: a SUCCEEDED attempt is auto-accepted (the Evaluator agent replaces
// this verdict in Phase 4 — the *wiring* is what this phase proves); a FAILED
// attempt goes through decideRetry (rule 10) and the verdict is persisted as
// a DecisionRecord before the task moves.
import {
  type Db,
  type EvaluationCandidate,
  insertDecisionRecord,
  selectEvaluationCandidates,
  updateTaskStatus,
} from "@lab/db";
import { CategorizedError, newId, ResearchStrategy, TaskType } from "@lab/schemas";
import { emitEvent } from "../events";
import { acceptAttempt } from "../liveness";
import { decideRetry, type RetryVerdict } from "../retry";
import { assertTaskTransition } from "../state/task";

const ACTOR = "retry_coordinator";

export interface EvaluationSweepResult {
  accepted: string[];
  retried: string[];
  failed: string[];
}

export async function sweepEvaluations(
  db: Db,
  now = () => new Date(),
): Promise<EvaluationSweepResult> {
  const result: EvaluationSweepResult = { accepted: [], retried: [], failed: [] };
  const candidates = await selectEvaluationCandidates(db);

  for (const c of candidates) {
    if (c.attemptStatus === "SUCCEEDED") {
      await acceptAttempt(db, c.attemptId, ACTOR);
      result.accepted.push(c.taskId);
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
  if (verdict.kind !== "task_failed" && c.attemptCount >= c.maxAttempts) {
    return {
      kind: "task_failed",
      rationale: `max_attempts (${c.maxAttempts}) exhausted after ${c.attemptCount} attempts; overriding ${verdict.kind}. Ladder said: ${verdict.rationale}`,
    };
  }
  return verdict;
}
