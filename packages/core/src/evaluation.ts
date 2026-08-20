// Evaluator-decision interpreter (ticket 4.4, design §14, phase-4-plan D3/D4).
// The Evaluator returns a DECISION; this module — code, not the agent — turns
// it into control-plane state: follow-up tasks, a replan stage, a fresh
// analysis, completion, or a human checkpoint. The ADR-016 cycle guard runs
// BEFORE any non-ACCEPT decision is interpreted: an LLM is never the only
// thing standing between the system and an infinite research loop.
import {
  type Db,
  type EvaluationCandidate,
  getRunForUpdate,
  insertEvaluation,
  insertHumanCheckpoint,
  insertPlannedTaskRow,
  insertTaskDependency,
  selectAcceptedEvaluationCycles,
  selectAttemptInput,
  selectAttemptOutput,
  selectMaxPlanStage,
  updateRunStatus,
} from "@lab/db";
import { EvaluatorOutput, newId, type RunStatus } from "@lab/schemas";
import { emitEvent } from "./events";
import { acceptAttemptInTx } from "./liveness";
import { PLACEHOLDER } from "./plan";
import { assertRunTransition } from "./state/run";

const ACTOR = "decision_interpreter";

export interface DecisionApplication {
  outcome:
    | "completed" // legacy/fake runs only — real ACCEPT enqueues synthesis (5.1)
    | "synthesis_enqueued"
    | "followups_created"
    | "replanned"
    | "reanalyze"
    | "waiting_human"
    | "cycle_guard"
    | "skipped"; // fake-handler evaluate task (no EvaluatorOutput)
  createdTaskIds: string[];
}

async function walkRun(
  tx: Parameters<typeof emitEvent>[0],
  runId: string,
  from: RunStatus,
  hops: RunStatus[],
): Promise<void> {
  let cur = from;
  for (const next of hops) {
    assertRunTransition(cur, next);
    await updateRunStatus(tx, runId, next);
    await emitEvent(tx, {
      runId,
      type: next === "COMPLETED" ? "RUN_COMPLETED" : "RUN_PHASE_CHANGED",
      kind: next === "COMPLETED" ? "accept" : "info",
      actor: ACTOR,
      payload: { from: cur, to: next },
    });
    cur = next;
  }
}

export async function applyEvaluatorDecision(
  db: Db,
  c: EvaluationCandidate,
  maxAttemptsDefault: number,
  maxEvalCycles: number,
): Promise<DecisionApplication> {
  return db.transaction(async (tx) => {
    await acceptAttemptInTx(tx, c.attemptId, ACTOR);

    const parsed = EvaluatorOutput.safeParse(await selectAttemptOutput(tx, c.attemptId));
    if (!parsed.success) return { outcome: "skipped" as const, createdTaskIds: [] };
    const out = parsed.data;

    const run = await getRunForUpdate(tx, c.runId);
    const cycle = await selectAcceptedEvaluationCycles(tx, c.runId); // includes this accept
    // Persist the verdict with the coverage the Evaluator actually saw (R13):
    // the attempt input is the verbatim context — never recomputed.
    const input = await selectAttemptInput(tx, c.attemptId);
    const evalId = newId();
    await insertEvaluation(tx, {
      id: evalId,
      runId: c.runId,
      targetType: "run",
      targetId: c.runId,
      evaluatorType: "agent",
      evaluatorName: "evaluator/v1",
      decision: out.decision,
      reasons: out.reasons,
      metadata: {
        cycle,
        coverage: (input?.coverage as Record<string, unknown> | undefined) ?? null,
        issues: out.issues,
        requiredActions: out.requiredActions,
        acceptedUncertainties: out.acceptedUncertainties,
      },
    });
    await emitEvent(tx, {
      runId: c.runId,
      taskId: c.taskId,
      attemptId: c.attemptId,
      type: "EVALUATION_DECISION",
      kind: out.decision === "ACCEPT" ? "accept" : "gate",
      actor: ACTOR,
      payload: { decision: out.decision, cycle, issues: out.issues.length },
    });

    const runStatus = (run?.status ?? "") as RunStatus;
    const canWalk = runStatus === "EVALUATING"; // fake/legacy runs skip the walk

    if (out.decision === "ACCEPT") {
      // 5.1 (phase-5-plan D4): ACCEPT no longer completes the run — it
      // enqueues the ONE synthesize task (input fully concrete, ADR-011) and
      // parks the run at SYNTHESIZING. Only an accepted, validator-passing
      // synthesis completes a run (acceptSynthesisAttempt). Legacy/fake runs
      // (no walkable status) keep the old terminal outcome.
      if (!canWalk) return { outcome: "completed" as const, createdTaskIds: [] };
      const synthesizeTaskId = newId();
      await insertPlannedTaskRow(tx, {
        id: synthesizeTaskId,
        runId: c.runId,
        planStage: Math.max(await selectMaxPlanStage(tx, c.runId), 1),
        specVersion: run?.specVersion ?? 1,
        type: "synthesize",
        title: "Synthesize report",
        description: "",
        priority: 95,
        agentRole: "synthesizer",
        modelTier: null,
        strategy: null,
        input: { evaluationId: evalId, cycle },
        successCriteria: [],
        maxAttempts: maxAttemptsDefault,
      });
      await insertTaskDependency(tx, synthesizeTaskId, c.taskId);
      await emitEvent(tx, {
        runId: c.runId,
        taskId: synthesizeTaskId,
        type: "SYNTHESIZE_TASK_CREATED",
        kind: "info",
        actor: ACTOR,
        payload: { cycle, evaluateTaskId: c.taskId },
      });
      await walkRun(tx, c.runId, "EVALUATING", ["SYNTHESIZING"]);
      return { outcome: "synthesis_enqueued" as const, createdTaskIds: [synthesizeTaskId] };
    }

    // ADR-016: deterministic guard, checked BEFORE interpreting the demand.
    if (cycle >= maxEvalCycles) {
      await insertHumanCheckpoint(tx, {
        id: newId(),
        runId: c.runId,
        taskId: c.taskId,
        reason: "cycle_guard",
        question: `Evaluation cycle cap (${maxEvalCycles}) reached with decision ${out.decision}. Continue, accept with uncertainties, or stop?`,
      });
      await emitEvent(tx, {
        runId: c.runId,
        taskId: c.taskId,
        attemptId: c.attemptId,
        type: "CYCLE_GUARD_TRIPPED",
        kind: "fail",
        actor: ACTOR,
        payload: { cycle, maxEvalCycles, decision: out.decision },
      });
      if (canWalk) {
        assertRunTransition("EVALUATING", "WAITING_HUMAN");
        await updateRunStatus(tx, c.runId, "WAITING_HUMAN");
        await emitEvent(tx, {
          runId: c.runId,
          type: "RUN_WAITING_HUMAN",
          kind: "warn",
          actor: ACTOR,
          payload: { reason: "cycle_guard" },
        });
      }
      return { outcome: "cycle_guard" as const, createdTaskIds: [] };
    }

    if (out.decision === "ESCALATE" || out.decision === "STOP") {
      await insertHumanCheckpoint(tx, {
        id: newId(),
        runId: c.runId,
        taskId: c.taskId,
        reason: "evaluator_escalation",
        question: out.reasons.join(" ").slice(0, 2000) || `Evaluator decided ${out.decision}.`,
      });
      if (canWalk) {
        assertRunTransition("EVALUATING", "WAITING_HUMAN");
        await updateRunStatus(tx, c.runId, "WAITING_HUMAN");
        await emitEvent(tx, {
          runId: c.runId,
          type: "RUN_WAITING_HUMAN",
          kind: "warn",
          actor: ACTOR,
          payload: { reason: "evaluator_escalation", decision: out.decision },
        });
      }
      return { outcome: "waiting_human" as const, createdTaskIds: [] };
    }

    const stage = Math.max(await selectMaxPlanStage(tx, c.runId), 1);
    const specVersion = run?.specVersion ?? 1;

    if (out.decision === "REANALYZE") {
      const analyzeTaskId = newId();
      await insertPlannedTaskRow(tx, {
        id: analyzeTaskId,
        runId: c.runId,
        planStage: stage,
        specVersion,
        type: "analyze",
        title: `Re-analyze (cycle ${cycle})`,
        description: "",
        priority: 90,
        agentRole: "analyst",
        modelTier: null,
        strategy: null,
        input: { evaluatorReasons: out.reasons.slice(0, 10) },
        successCriteria: [],
        maxAttempts: maxAttemptsDefault,
      });
      if (canWalk) await walkRun(tx, c.runId, "EVALUATING", ["RESEARCHING", "ANALYZING"]);
      return { outcome: "reanalyze" as const, createdTaskIds: [analyzeTaskId] };
    }

    if (out.decision === "REPLAN") {
      const planTaskId = newId();
      await insertPlannedTaskRow(tx, {
        id: planTaskId,
        runId: c.runId,
        planStage: stage + 1,
        specVersion,
        type: "plan",
        title: `Plan · stage ${stage + 1} (evaluator replan)`,
        description: "",
        priority: 95,
        agentRole: "planner",
        modelTier: null,
        strategy: null,
        input: { planStage: stage + 1, evaluatorFeedback: out },
        successCriteria: [],
        maxAttempts: maxAttemptsDefault,
      });
      await emitEvent(tx, {
        runId: c.runId,
        taskId: planTaskId,
        type: "PLAN_STAGE_ENQUEUED",
        kind: "info",
        actor: ACTOR,
        payload: { stage: stage + 1, source: "evaluator_replan" },
      });
      if (canWalk) await walkRun(tx, c.runId, "EVALUATING", ["RESEARCHING"]);
      return { outcome: "replanned" as const, createdTaskIds: [planTaskId] };
    }

    // RESEARCH_MORE: one requiredAction → one concrete research task in the
    // CURRENT stage (design §14: no Planner call, no new stage). Placeholder
    // questions were rejected pre-accept; this belt catches drift.
    const createdTaskIds: string[] = [];
    for (const action of out.requiredActions) {
      if (PLACEHOLDER.test(action.question)) continue;
      const taskId = newId();
      const taskInput: Record<string, unknown> = { researchQuestion: action.question };
      if (action.seedUrls && action.seedUrls.length > 0) taskInput.seedUrls = action.seedUrls;
      await insertPlannedTaskRow(tx, {
        id: taskId,
        runId: c.runId,
        planStage: stage,
        specVersion,
        type: "research",
        title: action.question.slice(0, 500),
        description: action.rationale,
        priority: 80, // evaluator-demanded work jumps ahead of speculative work (§15)
        agentRole: "researcher",
        modelTier: null,
        strategy: null,
        input: taskInput,
        successCriteria: [],
        maxAttempts: maxAttemptsDefault,
      });
      createdTaskIds.push(taskId);
      await emitEvent(tx, {
        runId: c.runId,
        taskId,
        type: "FOLLOWUP_TASK_CREATED",
        kind: "info",
        actor: ACTOR,
        payload: { cycle, question: action.question, rationale: action.rationale },
      });
    }
    if (canWalk) await walkRun(tx, c.runId, "EVALUATING", ["RESEARCHING"]);
    return { outcome: "followups_created" as const, createdTaskIds };
  });
}
