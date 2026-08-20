// Interactive plan editing (ticket 7.3, phase-7-plan D3). Humans edit the
// stage-1 plan THROUGH the control plane — never raw state (ADR-003 applies
// to people too). Every operation is one transaction, legal ONLY while the
// run holds a pending plan_review checkpoint (and, for task edits, while the
// target task is still CREATED), and leaves an audit trail: a PLAN_EDITED
// gate event + a human_plan_edit DecisionRecord with a readable summary —
// the transcript shows human edits the same way it shows evaluator demands.
import {
  type Db,
  getRunForUpdate,
  getTaskForUpdate,
  insertDecisionRecord,
  insertPlannedTaskRow,
  insertTaskDependency,
  selectPendingCheckpointId,
  selectTaskForContext,
  updatePlannedTaskFields,
  updateRunRoleTiers,
  updateTaskStatus,
} from "@lab/db";
import { CategorizedError, newId, type TaskStatus } from "@lab/schemas";
import { emitEvent } from "./events";
import { PLACEHOLDER } from "./plan";
import { assertTaskTransition } from "./state/task";

const ACTOR = "plan_editor";

export interface EditTaskArgs {
  title?: string;
  researchQuestion?: string;
  priority?: number;
  strategy?: string | null;
  modelTier?: string | null;
}

export interface AddTaskArgs {
  title: string;
  researchQuestion: string;
  priority?: number;
  strategy?: string | null;
  modelTier?: string | null;
  dependsOn?: string[];
}

type Tx = Parameters<typeof emitEvent>[0];

// Shared guard: edits exist only inside an open plan review.
async function requirePlanReview(tx: Tx, runId: string): Promise<string> {
  const run = await getRunForUpdate(tx, runId);
  if (!run) throw new CategorizedError("PERMANENT_INFRA", `run ${runId} does not exist`);
  const checkpointId = await selectPendingCheckpointId(tx, runId, "plan_review");
  if (run.status !== "WAITING_HUMAN" || !checkpointId) {
    throw new CategorizedError(
      "PERMANENT_INFRA",
      `run ${runId} is not open for plan editing — edits are legal only while a plan_review checkpoint is pending`,
    );
  }
  return checkpointId;
}

async function audit(
  tx: Tx,
  runId: string,
  taskId: string | null,
  actor: string,
  summary: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await insertDecisionRecord(tx, {
    id: newId(),
    runId,
    taskId,
    attemptId: null,
    type: "human_plan_edit",
    decision: "edit",
    rationale: summary,
    createdBy: actor,
    metadata: detail,
  });
  await emitEvent(tx, {
    runId,
    taskId: taskId ?? undefined,
    type: "PLAN_EDITED",
    kind: "gate",
    actor: ACTOR,
    payload: { summary, ...detail },
  });
}

export async function editPlannedTask(
  db: Db,
  runId: string,
  taskId: string,
  edit: EditTaskArgs,
  actor = "human",
): Promise<void> {
  if (edit.researchQuestion !== undefined && PLACEHOLDER.test(edit.researchQuestion)) {
    throw new CategorizedError(
      "QUALITY_FAILURE",
      "researchQuestion contains placeholder text — edits must stay concrete (ADR-011)",
    );
  }
  await db.transaction(async (tx) => {
    await requirePlanReview(tx, runId);
    const task = await getTaskForUpdate(tx, taskId);
    if (!task || task.runId !== runId) {
      throw new CategorizedError(
        "PERMANENT_INFRA",
        `task ${taskId} does not exist on run ${runId}`,
      );
    }
    if (task.status !== "CREATED") {
      throw new CategorizedError(
        "PERMANENT_INFRA",
        `task ${taskId} is ${task.status} — only CREATED tasks are editable`,
      );
    }
    let input: Record<string, unknown> | undefined;
    if (edit.researchQuestion !== undefined) {
      const current = await selectTaskForContext(tx, taskId);
      input = { ...(current?.input ?? {}), researchQuestion: edit.researchQuestion };
    }
    await updatePlannedTaskFields(tx, taskId, {
      title: edit.title,
      priority: edit.priority,
      strategy: edit.strategy,
      modelTier: edit.modelTier,
      input,
    });
    const changed = Object.entries(edit)
      .filter(([, v]) => v !== undefined)
      .map(([k]) => k);
    await audit(tx, runId, taskId, actor, `human edited task: ${changed.join(", ")}`, {
      changed,
      edit: edit as Record<string, unknown>,
    });
  });
}

export async function addPlannedTask(
  db: Db,
  runId: string,
  args: AddTaskArgs,
  actor = "human",
): Promise<string> {
  if (PLACEHOLDER.test(args.researchQuestion) || PLACEHOLDER.test(args.title)) {
    throw new CategorizedError(
      "QUALITY_FAILURE",
      "new task contains placeholder text — tasks must be concrete at creation (ADR-011)",
    );
  }
  return db.transaction(async (tx) => {
    await requirePlanReview(tx, runId);
    const run = await getRunForUpdate(tx, runId);
    const taskId = newId();
    await insertPlannedTaskRow(tx, {
      id: taskId,
      runId,
      planStage: 1, // review exists only at stage 1 (D1)
      specVersion: run?.specVersion ?? 1,
      type: "research",
      title: args.title,
      description: "added during plan review",
      priority: args.priority ?? 50,
      agentRole: "researcher",
      modelTier: args.modelTier ?? null,
      strategy: args.strategy ?? null,
      input: { researchQuestion: args.researchQuestion },
      successCriteria: [],
      maxAttempts: 3,
    });
    for (const dep of args.dependsOn ?? []) {
      const depTask = await getTaskForUpdate(tx, dep);
      if (!depTask || depTask.runId !== runId) {
        throw new CategorizedError(
          "PERMANENT_INFRA",
          `dependsOn ${dep} does not name a task in this run`,
        );
      }
      await insertTaskDependency(tx, taskId, dep);
    }
    await audit(tx, runId, taskId, actor, `human added research task: ${args.title}`, {
      researchQuestion: args.researchQuestion,
    });
    return taskId;
  });
}

export async function removePlannedTask(
  db: Db,
  runId: string,
  taskId: string,
  actor = "human",
): Promise<void> {
  await db.transaction(async (tx) => {
    await requirePlanReview(tx, runId);
    const task = await getTaskForUpdate(tx, taskId);
    if (!task || task.runId !== runId) {
      throw new CategorizedError(
        "PERMANENT_INFRA",
        `task ${taskId} does not exist on run ${runId}`,
      );
    }
    assertTaskTransition(task.status as TaskStatus, "CANCELLED"); // retirement, never deletion
    await updateTaskStatus(tx, taskId, "CANCELLED");
    await audit(tx, runId, taskId, actor, "human removed task from the plan", {});
  });
}

export async function updateRunRouting(
  db: Db,
  runId: string,
  roleTiers: Record<string, string>,
  actor = "human",
): Promise<void> {
  await db.transaction(async (tx) => {
    await requirePlanReview(tx, runId);
    await updateRunRoleTiers(tx, runId, roleTiers);
    await audit(tx, runId, null, actor, "human updated per-role model routing", { roleTiers });
  });
}
