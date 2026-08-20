// Checkpoint resolution (ticket 6.4, phase-6-plan D5). The human answers a
// WAITING_HUMAN checkpoint with one of three deliberately small verbs; the
// Control Plane interprets — the human never mutates task state directly
// (the ADR-003 discipline applies to people too). One transaction: checkpoint
// resolved (+response verbatim) → DecisionRecord with the human rationale →
// gate event → the legal state walk for the verb.
//
//   retry  — analysis_failed / synthesis_failed: the failed loop task is
//            RETIRED (FAILED → CANCELLED, the 6.4 human-retirement
//            transition) and a fresh task of the same type takes its place;
//            run walks back to the matching phase.
//   accept — cycle_guard only: proceed to synthesis with the material on
//            hand; recorded as a HUMAN evaluation row (ADR-016 stays intact —
//            the guard tripped, a person chose to continue past it, and that
//            choice is auditable).
//   stop   — any reason: the run is cancelled outright.
import {
  cancelAttemptsForRun,
  cancelTasksForRun,
  type Db,
  getCheckpointForUpdate,
  getRunForUpdate,
  insertDecisionRecord,
  insertEvaluation,
  insertPlannedTaskRow,
  markCheckpointResolved,
  selectAnalysisLoopTasks,
  selectMaxPlanStage,
  updateRunStatus,
  updateTaskStatus,
} from "@lab/db";
import type { TaskStatus } from "@lab/schemas";
import { CategorizedError, newId, type RunStatus } from "@lab/schemas";
import { emitEvent } from "./events";
import { assertRunTransition } from "./state/run";
import { assertTaskTransition } from "./state/task";

const ACTOR = "checkpoint_resolver";

export type CheckpointAction = "retry" | "accept" | "stop" | "approve";

const RETRYABLE_REASONS = new Set(["analysis_failed", "synthesis_failed"]);

export interface CheckpointResolution {
  action: CheckpointAction;
  createdTaskIds: string[];
}

export async function resolveCheckpoint(
  db: Db,
  args: {
    runId: string;
    checkpointId: string;
    action: CheckpointAction;
    note?: string;
    actor?: string; // who answered — recorded on the DecisionRecord
  },
): Promise<CheckpointResolution> {
  const { runId, checkpointId, action } = args;
  const actor = args.actor ?? "human";
  return db.transaction(async (tx) => {
    const cp = await getCheckpointForUpdate(tx, checkpointId);
    if (!cp || cp.runId !== runId) {
      throw new CategorizedError(
        "PERMANENT_INFRA",
        `checkpoint ${checkpointId} does not exist on run ${runId}`,
      );
    }
    if (cp.status !== "pending") {
      throw new CategorizedError(
        "PERMANENT_INFRA",
        `checkpoint ${checkpointId} is already ${cp.status}`,
      );
    }
    if (action === "retry" && !RETRYABLE_REASONS.has(cp.reason)) {
      throw new CategorizedError(
        "PERMANENT_INFRA",
        `action 'retry' is not valid for reason '${cp.reason}' — retry re-runs a failed analysis/synthesis only`,
      );
    }
    if (action === "accept" && cp.reason !== "cycle_guard") {
      throw new CategorizedError(
        "PERMANENT_INFRA",
        `action 'accept' is only valid for a cycle_guard checkpoint (got '${cp.reason}')`,
      );
    }
    if (action === "approve" && cp.reason !== "plan_review") {
      throw new CategorizedError(
        "PERMANENT_INFRA",
        `action 'approve' is only valid for a plan_review checkpoint (got '${cp.reason}')`,
      );
    }
    const run = await getRunForUpdate(tx, runId);
    if (!run) throw new CategorizedError("PERMANENT_INFRA", `run ${runId} does not exist`);

    await markCheckpointResolved(tx, checkpointId, {
      action,
      note: args.note ?? null,
      actor,
    });
    await insertDecisionRecord(tx, {
      id: newId(),
      runId,
      taskId: cp.taskId,
      attemptId: null,
      type: "human_checkpoint",
      decision: action,
      rationale:
        args.note?.slice(0, 2000) || `human resolved '${cp.reason}' checkpoint with '${action}'`,
      createdBy: actor,
      metadata: { checkpointId, reason: cp.reason },
    });
    await emitEvent(tx, {
      runId,
      taskId: cp.taskId,
      type: "CHECKPOINT_RESOLVED",
      kind: "gate", // a human judgment point (§24.3)
      actor: ACTOR,
      payload: { checkpointId, reason: cp.reason, action },
    });

    // approve (plan_review, 7.2): release the stage-1 hold. Tasks were
    // created normally at plan acceptance; walking the run back to
    // RESEARCHING lets the readiness sweep promote them in dependency order.
    if (action === "approve") {
      assertRunTransition(run.status as RunStatus, "RESEARCHING");
      await updateRunStatus(tx, runId, "RESEARCHING");
      await emitEvent(tx, {
        runId,
        type: "RUN_PHASE_CHANGED",
        kind: "info",
        actor: ACTOR,
        payload: { from: run.status, to: "RESEARCHING", reason: "plan_approved" },
      });
      return { action, createdTaskIds: [] };
    }

    if (action === "stop") {
      assertRunTransition(run.status as RunStatus, "CANCELLED");
      const attempts = await cancelAttemptsForRun(tx, runId);
      const tasks = await cancelTasksForRun(tx, runId);
      await updateRunStatus(tx, runId, "CANCELLED");
      await emitEvent(tx, {
        runId,
        type: "RUN_CANCELLED",
        kind: "warn",
        actor: ACTOR,
        payload: { cancelledTasks: tasks.length, cancelledAttempts: attempts.length },
      });
      return { action, createdTaskIds: [] };
    }

    const stage = Math.max(await selectMaxPlanStage(tx, runId), 1);
    const createTask = async (type: "analyze" | "synthesize"): Promise<string> => {
      const taskId = newId();
      await insertPlannedTaskRow(tx, {
        id: taskId,
        runId,
        planStage: stage,
        specVersion: run.specVersion,
        type,
        title: type === "analyze" ? "Analyze findings (human retry)" : "Synthesize report",
        description: "",
        priority: type === "analyze" ? 90 : 95,
        agentRole: type === "analyze" ? "analyst" : "synthesizer",
        modelTier: null,
        strategy: null,
        input: { humanRetry: true, checkpointId },
        successCriteria: [],
        maxAttempts: 3,
      });
      await emitEvent(tx, {
        runId,
        taskId,
        type: type === "analyze" ? "ANALYZE_TASK_CREATED" : "SYNTHESIZE_TASK_CREATED",
        kind: "info",
        actor: ACTOR,
        payload: { reason: "human_retry", checkpointId },
      });
      return taskId;
    };

    if (action === "retry") {
      // Retire every failed/blocked loop task so the completion sweep stops
      // re-parking the run on it; a fresh task supersedes.
      const loopTasks = await selectAnalysisLoopTasks(tx, runId);
      const failed = loopTasks.filter((t) => t.status === "FAILED" || t.status === "BLOCKED");
      for (const t of failed) {
        assertTaskTransition(t.status as TaskStatus, "CANCELLED");
        await updateTaskStatus(tx, t.id, "CANCELLED");
      }
      const type = failed.some((t) => t.type === "synthesize") ? "synthesize" : "analyze";
      const taskId = await createTask(type);
      const phase = type === "synthesize" ? "SYNTHESIZING" : "ANALYZING";
      assertRunTransition(run.status as RunStatus, phase);
      await updateRunStatus(tx, runId, phase);
      await emitEvent(tx, {
        runId,
        type: "RUN_PHASE_CHANGED",
        kind: "info",
        actor: ACTOR,
        payload: { from: run.status, to: phase },
      });
      return { action, createdTaskIds: [taskId] };
    }

    // accept (cycle_guard): a human evaluation continues the run past the
    // guard into synthesis with the material on hand.
    await insertEvaluation(tx, {
      id: newId(),
      runId,
      targetType: "run",
      targetId: runId,
      evaluatorType: "human",
      evaluatorName: actor,
      decision: "ACCEPT",
      reasons: [args.note?.slice(0, 2000) || "human accepted past the cycle guard"],
      metadata: { checkpointId, source: "cycle_guard_accept" },
    });
    const taskId = await createTask("synthesize");
    assertRunTransition(run.status as RunStatus, "SYNTHESIZING");
    await updateRunStatus(tx, runId, "SYNTHESIZING");
    await emitEvent(tx, {
      runId,
      type: "RUN_PHASE_CHANGED",
      kind: "info",
      actor: ACTOR,
      payload: { from: run.status, to: "SYNTHESIZING" },
    });
    return { action, createdTaskIds: [taskId] };
  });
}
