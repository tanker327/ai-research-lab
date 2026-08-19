// Shared quality-rejection path for SUCCEEDED attempts (tickets 3.2/3.6).
// One transaction: evaluations row (the rule's verdict) → attempt REJECTED →
// decideRetry + attempt cap (rule 10) → task transition → DecisionRecord →
// event. Every rationale is human-readable (§24.2 renders it verbatim).
import {
  type EvaluationCandidate,
  insertDecisionRecord,
  insertEvaluation,
  markAttemptRejected,
  type Tx,
  updateTaskStatus,
} from "@lab/db";
import { newId, ResearchStrategy, TaskType } from "@lab/schemas";
import type { CheckFailure } from "./checks";
import { emitEvent } from "./events";
import { decideRetry, enforceAttemptCap } from "./retry";
import { assertAttemptTransition } from "./state/attempt";
import { assertTaskTransition } from "./state/task";

export interface QualityRejection {
  outcome: "rejected";
  verdictKind: "intelligence_retry" | "task_failed" | "infra_retry";
  rationale: string;
}

export async function rejectSucceededAttempt(
  tx: Tx,
  c: EvaluationCandidate,
  failures: CheckFailure[],
  opts: { decisionType: string; actor: string },
): Promise<QualityRejection> {
  const reasons = failures.map((f) => f.reason);
  for (const f of failures) {
    await insertEvaluation(tx, {
      id: newId(),
      runId: c.runId,
      targetType: "attempt",
      targetId: c.attemptId,
      evaluatorType: "rule",
      evaluatorName: f.check,
      decision: "REJECT",
      reasons: [f.reason],
      metadata: {},
    });
  }

  assertAttemptTransition("SUCCEEDED", "REJECTED");
  await markAttemptRejected(tx, c.attemptId);

  const verdict = enforceAttemptCap(
    decideRetry(
      {
        taskType: TaskType.parse(c.taskType),
        attemptNumber: c.attemptNumber,
        infraRetryCount: Math.max(0, c.infraFailureCount - 1),
        strategy: ResearchStrategy.safeParse(c.strategy).data ?? null,
      },
      null,
      { rejected: true, reasons },
    ),
    c.attemptCount,
    c.maxAttempts,
  );
  const to = verdict.kind === "task_failed" ? "FAILED" : "READY";
  assertTaskTransition("EVALUATING", to);
  await updateTaskStatus(tx, c.taskId, to);
  await insertDecisionRecord(tx, {
    id: newId(),
    runId: c.runId,
    taskId: c.taskId,
    attemptId: c.attemptId,
    type: opts.decisionType,
    decision: verdict.kind,
    rationale: `${reasons.join(" · ")}. Ladder: ${verdict.rationale}`,
    createdBy: opts.actor,
    metadata: { checks: failures.map((f) => f.check) },
  });
  await emitEvent(tx, {
    runId: c.runId,
    taskId: c.taskId,
    attemptId: c.attemptId,
    type: verdict.kind === "task_failed" ? "TASK_FAILED" : "TASK_RETRY",
    kind: verdict.kind === "task_failed" ? "fail" : "warn",
    actor: opts.actor,
    payload: { decision: verdict.kind, reasons },
  });
  return { outcome: "rejected", verdictKind: verdict.kind, rationale: reasons.join(" · ") };
}
