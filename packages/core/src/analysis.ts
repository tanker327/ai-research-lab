// Analysis accept (ticket 4.4, phase-4-plan D4). When an analyze attempt is
// ACCEPTED, the Control Plane creates the evaluate task in the SAME
// transaction (the P3 research→extract pattern) and advances the run
// ANALYZING → EVALUATING. Fake-handler analyze tasks (phase-1 chains, gates)
// have no AnalysisOutput — they accept plainly and the run walk is skipped.
import {
  type Db,
  type EvaluationCandidate,
  getRunForUpdate,
  insertPlannedTaskRow,
  insertTaskDependency,
  selectAttemptOutput,
  selectMaxPlanStage,
  updateRunStatus,
} from "@lab/db";
import { AnalysisOutput, newId } from "@lab/schemas";
import { emitEvent } from "./events";
import { acceptAttemptInTx } from "./liveness";
import { assertRunTransition } from "./state/run";

const ACTOR = "evaluation_enqueuer";

export interface AnalysisAcceptance {
  evaluateTaskId: string | null; // null: no AnalysisOutput (fake-handler era)
}

export async function acceptAnalysisAttempt(
  db: Db,
  c: EvaluationCandidate,
): Promise<AnalysisAcceptance> {
  return db.transaction(async (tx) => {
    await acceptAttemptInTx(tx, c.attemptId, ACTOR);

    const parsed = AnalysisOutput.safeParse(await selectAttemptOutput(tx, c.attemptId));
    if (!parsed.success) {
      await emitEvent(tx, {
        runId: c.runId,
        taskId: c.taskId,
        attemptId: c.attemptId,
        type: "EVALUATE_SKIPPED",
        kind: "info",
        actor: ACTOR,
        payload: { reason: "attempt output is not an AnalysisOutput" },
      });
      return { evaluateTaskId: null };
    }
    await emitEvent(tx, {
      runId: c.runId,
      taskId: c.taskId,
      attemptId: c.attemptId,
      type: "ANALYSIS_ACCEPTED",
      kind: "accept",
      actor: ACTOR,
      payload: { findings: parsed.data.findings.length },
    });

    const run = await getRunForUpdate(tx, c.runId);
    const stage = await selectMaxPlanStage(tx, c.runId);
    const evaluateTaskId = newId();
    await insertPlannedTaskRow(tx, {
      id: evaluateTaskId,
      runId: c.runId,
      planStage: Math.max(stage, 1),
      specVersion: run?.specVersion ?? 1,
      type: "evaluate",
      title: "Evaluate analysis",
      description: "",
      priority: 95,
      agentRole: "evaluator",
      modelTier: null,
      strategy: null,
      // The evaluator context is built whole-run at claim time (coverage,
      // metrics, latest analysis) — the input only marks the trigger.
      input: { analysisAttemptId: c.attemptId },
      successCriteria: [],
      maxAttempts: 3,
    });
    await insertTaskDependency(tx, evaluateTaskId, c.taskId);
    await emitEvent(tx, {
      runId: c.runId,
      taskId: evaluateTaskId,
      type: "EVALUATE_TASK_CREATED",
      kind: "info",
      actor: ACTOR,
      payload: { analyzeTaskId: c.taskId },
    });

    if (run && run.status === "ANALYZING") {
      assertRunTransition("ANALYZING", "EVALUATING");
      await updateRunStatus(tx, c.runId, "EVALUATING");
      await emitEvent(tx, {
        runId: c.runId,
        type: "RUN_PHASE_CHANGED",
        kind: "info",
        actor: ACTOR,
        payload: { from: "ANALYZING", to: "EVALUATING" },
      });
    }
    return { evaluateTaskId };
  });
}
