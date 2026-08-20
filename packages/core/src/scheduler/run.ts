// Run coordinator (ticket 1.7): start, completion sweep, cancellation.
// Phase 1 runs carry an explicit task list (the Planner replaces this in
// Phase 3), so the run's phase walk is driven purely by task-set state.
import {
  cancelAttemptsForRun,
  cancelTasksForRun,
  countLiveClaims,
  type Db,
  existsPlanTaskForStage,
  getRunForUpdate,
  insertPlannedTaskRow,
  insertRun,
  insertTask,
  insertTaskDependency,
  selectActiveRuns,
  selectMaxPlanStage,
  taskStatusCounts,
  updateRunStatus,
} from "@lab/db";
import { CategorizedError, newId, type RunStatus, TaskType } from "@lab/schemas";
import { emitEvent } from "../events";
import { ROLE_FOR_TYPE } from "../plan";
import { assertRunTransition } from "../state/run";
import { checkBudgetStub } from "./budget";

const ACTOR = "run_coordinator";

// The staged walk (design §8.2). Phase 1 has no per-phase agents, so a run
// whose tasks are all DONE walks the remaining phases legally in one sweep —
// each hop asserted and evented, never a jump.
const PHASE_CHAIN: RunStatus[] = [
  "CREATED",
  "PLANNING",
  "RESEARCHING",
  "ANALYZING",
  "EVALUATING",
  "SYNTHESIZING",
  "COMPLETED",
];

async function advanceRun(
  tx: Parameters<typeof emitEvent>[0],
  runId: string,
  from: RunStatus,
  to: RunStatus,
): Promise<void> {
  const path = PHASE_CHAIN.slice(PHASE_CHAIN.indexOf(from), PHASE_CHAIN.indexOf(to) + 1);
  for (let i = 0; i + 1 < path.length; i++) {
    const [a, b] = [path[i], path[i + 1]];
    if (!a || !b) break;
    assertRunTransition(a, b);
    await updateRunStatus(tx, runId, b);
    await emitEvent(tx, {
      runId,
      type: b === "COMPLETED" ? "RUN_COMPLETED" : "RUN_PHASE_CHANGED",
      kind: b === "COMPLETED" ? "accept" : "info",
      actor: ACTOR,
      payload: { from: a, to: b },
    });
  }
}

export interface StartRunInput {
  id?: string;
  title?: string | null;
  userRequest: string;
  budget?: Record<string, unknown>;
  tasks: Array<{
    id?: string;
    type: string;
    title: string;
    priority?: number;
    strategy?: string | null;
    maxAttempts?: number;
    input: Record<string, unknown>;
    dependsOn?: string[]; // indexes into this array are not allowed — real ids
  }>;
}

export async function startRun(db: Db, req: StartRunInput): Promise<string> {
  const runId = req.id ?? newId();
  await db.transaction(async (tx) => {
    await insertRun(tx, {
      id: runId,
      title: req.title ?? null,
      userRequest: req.userRequest,
      budget: req.budget ?? {},
    });
    await emitEvent(tx, { runId, type: "RUN_CREATED", kind: "info", actor: ACTOR });

    // Resolve ids first: a task may omit its id, but a dependsOn target must
    // name a real (explicit) id from this list.
    const withIds = req.tasks.map((t) => ({ ...t, id: t.id ?? newId() }));
    for (const t of withIds) {
      await insertTask(tx, {
        id: t.id,
        runId,
        type: t.type,
        title: t.title,
        priority: t.priority ?? 50,
        strategy: t.strategy ?? null,
        maxAttempts: t.maxAttempts ?? 3,
        input: t.input,
        // real dispatch since 3.2; fake inputs still escape to the fake handler
        agentRole: ROLE_FOR_TYPE[TaskType.parse(t.type)],
      });
    }
    for (const t of withIds) {
      for (const dep of t.dependsOn ?? []) {
        if (!withIds.some((o) => o.id === dep)) {
          throw new CategorizedError(
            "PERMANENT_INFRA",
            `dependsOn ${dep} does not name a task in this run`,
          );
        }
        await insertTaskDependency(tx, t.id, dep);
      }
    }

    // Planning is the caller-provided task list in Phase 1: walk straight to
    // RESEARCHING so the readiness sweep starts promoting tasks.
    await advanceRun(tx, runId, "CREATED", "RESEARCHING");

    const warnings = checkBudgetStub(req.budget ?? {}, { taskCount: req.tasks.length });
    for (const w of warnings) {
      await emitEvent(tx, {
        runId,
        type: "BUDGET_WARNING",
        kind: "warn",
        actor: ACTOR,
        payload: { warning: w },
      });
    }
  });
  return runId;
}

export interface RunCompletionSweepResult {
  completed: string[];
  failed: string[];
}

export async function sweepRunCompletion(
  db: Db,
  maxPlanStages = 2, // V0.05: discovery + one deep wave; the Evaluator drives more in P4
): Promise<RunCompletionSweepResult> {
  const result: RunCompletionSweepResult = { completed: [], failed: [] };
  const active = await selectActiveRuns(db);

  for (const run of active) {
    await db.transaction(async (tx) => {
      const locked = await getRunForUpdate(tx, run.id);
      if (!locked || locked.status !== run.status) return; // moved under us
      const counts = await taskStatusCounts(tx, run.id);
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      if (total === 0) return; // nothing seeded yet
      const terminal = (counts.DONE ?? 0) + (counts.FAILED ?? 0) + (counts.CANCELLED ?? 0);
      if (terminal < total) return; // work still in flight

      const liveClaims = await countLiveClaims(tx, run.id);

      // Staged-planning driver (3.7, ADR-011): all work is done, the last
      // plan stage produced live claims, and stages remain → enqueue the
      // next plan task instead of completing. Failed leaf tasks do NOT stop
      // the next stage (ADR-010) — the claims that exist are real material.
      {
        const lastStage = await selectMaxPlanStage(tx, run.id);
        if (
          lastStage > 0 &&
          lastStage < maxPlanStages &&
          !(await existsPlanTaskForStage(tx, run.id, lastStage + 1)) &&
          liveClaims > 0
        ) {
          const nextStage = lastStage + 1;
          const planTaskId = newId();
          await insertPlannedTaskRow(tx, {
            id: planTaskId,
            runId: run.id,
            planStage: nextStage,
            specVersion: locked.specVersion,
            type: "plan",
            title: `Plan · stage ${nextStage}`,
            description: "",
            priority: 90,
            agentRole: "planner",
            modelTier: null,
            strategy: null,
            input: { planStage: nextStage },
            successCriteria: [],
            maxAttempts: 3,
          });
          await emitEvent(tx, {
            runId: run.id,
            taskId: planTaskId,
            type: "PLAN_STAGE_ENQUEUED",
            kind: "info",
            actor: ACTOR,
            payload: { stage: nextStage },
          });
          return; // run stays active; readiness sweep picks the plan task up
        }
      }

      // ADR-010: failure is normal. A run with live claims and at least one
      // DONE task completes even when some leaf tasks failed — the failures
      // stay visible (RUN_DEGRADED warn; the P4 Evaluator will judge them).
      // No claims to show for it → the run failed.
      const failedOrCancelled = (counts.FAILED ?? 0) + (counts.CANCELLED ?? 0);
      if (failedOrCancelled > 0 && !((counts.DONE ?? 0) > 0 && liveClaims > 0)) {
        assertRunTransition(locked.status, "FAILED");
        await updateRunStatus(tx, run.id, "FAILED");
        await emitEvent(tx, {
          runId: run.id,
          type: "RUN_FAILED",
          kind: "fail",
          actor: ACTOR,
          payload: { counts },
        });
        result.failed.push(run.id);
        return;
      }
      if ((counts.FAILED ?? 0) > 0) {
        await emitEvent(tx, {
          runId: run.id,
          type: "RUN_DEGRADED",
          kind: "warn",
          actor: ACTOR,
          payload: { counts, liveClaims },
        });
      }
      await advanceRun(tx, run.id, locked.status, "COMPLETED");
      result.completed.push(run.id);
    });
  }
  return result;
}

// Matrix row 10: cancel mid-wave. Everything non-terminal — run, tasks,
// in-flight attempts — flips to CANCELLED in one transaction; a worker
// finishing later loses its claim check in finishAttempt and discards.
export async function cancelRun(db: Db, runId: string, actor = "api"): Promise<void> {
  await db.transaction(async (tx) => {
    const run = await getRunForUpdate(tx, runId);
    if (!run) throw new CategorizedError("PERMANENT_INFRA", `run ${runId} does not exist`);
    assertRunTransition(run.status, "CANCELLED");
    const attempts = await cancelAttemptsForRun(tx, runId);
    const tasks = await cancelTasksForRun(tx, runId);
    await updateRunStatus(tx, runId, "CANCELLED");
    await emitEvent(tx, {
      runId,
      type: "RUN_CANCELLED",
      kind: "warn",
      actor,
      payload: { cancelledTasks: tasks.length, cancelledAttempts: attempts.length },
    });
  });
}
