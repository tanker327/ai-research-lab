// PlanDelta interpretation (ticket 3.2, design §7, ADR-003/ADR-011). The
// Planner returns a schema-validated decision; THIS code — not the agent —
// mutates control state, in one transaction with the attempt acceptance:
// spec version, plan_stages row, new tasks (concrete-input guard + cycle
// guard), cancels/supersedes, human checkpoints, events.
import {
  type Db,
  type EvaluationCandidate,
  getTaskForUpdate,
  insertDecisionRecord,
  insertHumanCheckpoint,
  insertPlannedTaskRow,
  insertPlanStage,
  insertSpec,
  insertTaskDependency,
  markAttemptRejected,
  selectAttemptOutput,
  selectRunForContext,
  selectTaskForContext,
  type Tx,
  updateTaskStatus,
} from "@lab/db";
import {
  CategorizedError,
  newId,
  type PlannedTask,
  PlannerOutput,
  ResearchStrategy,
  type TaskStatus,
  TaskType,
  newId as uuid,
} from "@lab/schemas";
import { emitEvent } from "./events";
import { acceptAttemptInTx } from "./liveness";
import { decideRetry, enforceAttemptCap } from "./retry";
import { assertAttemptTransition } from "./state/attempt";
import { assertTaskTransition } from "./state/task";

const ACTOR = "plan_interpreter";

// Executable staged-planning invariant (rule 12): inputs that smell like
// templates are rejected before any task row exists.
const PLACEHOLDER = /\{\{|\{%|<insert|<fill|\bTBD\b|\bTODO\b|\bPLACEHOLDER\b|\bFIXME\b/i;

export function findConcretenessViolation(t: PlannedTask): string | null {
  const rendered = JSON.stringify(t.input);
  const m = PLACEHOLDER.exec(rendered) ?? PLACEHOLDER.exec(t.title);
  if (m) return `task '${t.localId}' contains placeholder text '${m[0]}'`;
  if (t.type === "research") {
    const q = t.researchQuestion ?? t.input.researchQuestion;
    if (typeof q !== "string" || q.trim().length < 8) {
      return `research task '${t.localId}' has no concrete researchQuestion`;
    }
  }
  return null;
}

// Deterministic cycle guard (ADR-016) over the localId graph.
export function findDependencyCycle(tasks: PlannedTask[]): string | null {
  const local = new Set(tasks.map((t) => t.localId));
  const edges = new Map<string, string[]>();
  for (const t of tasks) {
    edges.set(
      t.localId,
      t.dependencies.filter((d) => local.has(d)),
    );
  }
  const state = new Map<string, 1 | 2>(); // 1 = visiting, 2 = done
  const visit = (id: string): boolean => {
    if (state.get(id) === 2) return false;
    if (state.get(id) === 1) return true;
    state.set(id, 1);
    for (const dep of edges.get(id) ?? []) {
      if (visit(dep)) return true;
    }
    state.set(id, 2);
    return false;
  };
  for (const t of tasks) {
    if (visit(t.localId)) return `dependency cycle involving '${t.localId}'`;
  }
  return null;
}

const ROLE_FOR_TYPE: Record<TaskType, string> = {
  plan: "planner",
  research: "researcher",
  extract: "extractor",
  analyze: "analyst",
  evaluate: "evaluator",
  synthesize: "synthesizer",
  human_review: "human",
};

export interface PlanApplication {
  outcome: "applied" | "rejected";
  createdTaskIds: string[];
  rationale: string;
}

// Called by the evaluation sweep for a SUCCEEDED attempt on a `plan` task.
// Valid output → accept + interpret atomically. Invalid output → the attempt
// is REJECTED and the retry ladder (rule 10) decides what happens next.
export async function applyAcceptedPlan(
  db: Db,
  c: EvaluationCandidate,
  maxAttemptsDefault: number,
): Promise<PlanApplication> {
  return db.transaction(async (tx) => {
    const output = await selectAttemptOutput(tx, c.attemptId);
    const parsed = PlannerOutput.safeParse(output);
    if (!parsed.success) {
      return rejectPlan(
        tx,
        c,
        `planner output failed schema validation: ${parsed.error.message.slice(0, 300)}`,
      );
    }
    const plan = parsed.data;
    for (const t of plan.planDelta.addTasks) {
      const violation = findConcretenessViolation(t);
      if (violation) return rejectPlan(tx, c, `staged-planning violation (ADR-011): ${violation}`);
    }
    const cycle = findDependencyCycle(plan.planDelta.addTasks);
    if (cycle) return rejectPlan(tx, c, `plan rejected (ADR-016): ${cycle}`);

    await acceptAttemptInTx(tx, c.attemptId, ACTOR);

    const run = await selectRunForContext(tx, c.runId);
    const specVersion = (run?.specVersion ?? 0) + 1;
    await insertSpec(tx, {
      id: uuid(),
      runId: c.runId,
      version: specVersion,
      ...plan.specification,
      clarificationsAssumed: plan.clarificationsAssumed,
    });

    const planTask = await selectTaskForContext(tx, c.taskId);
    const stage = Number(planTask?.input.planStage ?? 1);
    await insertPlanStage(tx, {
      id: uuid(),
      runId: c.runId,
      stage,
      specVersion,
      delta: plan.planDelta,
      rationale: plan.planDelta.rationale,
    });

    // localId → real id; dependencies may also name existing task UUIDs.
    const idFor = new Map<string, string>();
    for (const t of plan.planDelta.addTasks) idFor.set(t.localId, uuid());
    const createdTaskIds: string[] = [];
    for (const t of plan.planDelta.addTasks) {
      const id = idFor.get(t.localId);
      if (!id) continue;
      const input = { ...t.input };
      if (t.type === "research" && t.researchQuestion && input.researchQuestion === undefined) {
        input.researchQuestion = t.researchQuestion;
      }
      await insertPlannedTaskRow(tx, {
        id,
        runId: c.runId,
        planStage: stage,
        specVersion,
        type: t.type,
        title: t.title,
        description: t.description,
        priority: t.priority,
        agentRole: ROLE_FOR_TYPE[t.type],
        modelTier: t.suggestedModelTier ?? null,
        strategy: t.strategy ?? null,
        input,
        successCriteria: t.successCriteria,
        maxAttempts: maxAttemptsDefault,
      });
      for (const dep of t.dependencies) {
        await insertTaskDependency(tx, id, idFor.get(dep) ?? dep);
      }
      await emitEvent(tx, {
        runId: c.runId,
        taskId: id,
        type: "TASK_PLANNED",
        kind: "info",
        actor: ACTOR,
        payload: { localId: t.localId, type: t.type, title: t.title, planStage: stage },
      });
      createdTaskIds.push(id);
    }

    for (const [ids, to] of [
      [plan.planDelta.cancelTaskIds, "CANCELLED"],
      [plan.planDelta.supersedeTaskIds, "CANCELLED"],
    ] as const) {
      for (const taskId of ids) {
        const task = await getTaskForUpdate(tx, taskId);
        if (!task) continue; // planner named an unknown id — delta already logged
        assertTaskTransition(task.status as TaskStatus, to);
        await updateTaskStatus(tx, taskId, to);
        await emitEvent(tx, {
          runId: c.runId,
          taskId,
          type: "TASK_CANCELLED_BY_PLAN",
          kind: "warn",
          actor: ACTOR,
          payload: { planStage: stage },
        });
      }
    }

    for (const q of plan.humanQuestions ?? []) {
      await insertHumanCheckpoint(tx, {
        id: uuid(),
        runId: c.runId,
        taskId: c.taskId,
        reason: "scope_ambiguity",
        question: `${q.question} (why: ${q.whyUnsafeToInfer})`,
      });
      await emitEvent(tx, {
        runId: c.runId,
        taskId: c.taskId,
        type: "HUMAN_QUESTION_RAISED",
        kind: "gate",
        actor: ACTOR,
        payload: { question: q.question },
      });
    }

    return {
      outcome: "applied" as const,
      createdTaskIds,
      rationale: plan.planDelta.rationale,
    };
  });
}

// The reject path stays on the ladder (rule 10): decideRetry owns what
// happens next; this only records the verdict.
async function rejectPlan(
  tx: Tx,
  c: EvaluationCandidate,
  reason: string,
): Promise<PlanApplication> {
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
      { rejected: true, reasons: [reason] },
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
    type: "plan_rejection",
    decision: verdict.kind,
    rationale: `${reason}. Ladder: ${verdict.rationale}`,
    createdBy: ACTOR,
    metadata: {},
  });
  await emitEvent(tx, {
    runId: c.runId,
    taskId: c.taskId,
    attemptId: c.attemptId,
    type: verdict.kind === "task_failed" ? "TASK_FAILED" : "TASK_RETRY",
    kind: verdict.kind === "task_failed" ? "fail" : "warn",
    actor: ACTOR,
    payload: { decision: verdict.kind, rationale: reason },
  });
  return { outcome: "rejected", createdTaskIds: [], rationale: reason };
}
