// Ticket 6.4 acceptance: checkpoint resolution against real Postgres — each
// verb's transaction (resolved row + DecisionRecord + gate event + legal
// walk), and the illegal combinations.
import { createDb, deleteRun, insertHumanCheckpoint, seedRun, seedTask } from "@lab/db";
import { CategorizedError, newId } from "@lab/schemas";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { resolveCheckpoint } from "./checkpoint";

const url = process.env.DATABASE_URL ?? "postgres://lab:lab@localhost:5434/research_lab";
const { db, close } = createDb(url);

const cleanup: string[] = [];
afterEach(async () => {
  while (cleanup.length) {
    const id = cleanup.pop();
    if (id) await deleteRun(db, id);
  }
});
afterAll(async () => {
  await close();
});

async function seedParkedRun(reason: string, failedTaskType: "analyze" | "synthesize" | null) {
  const runId = newId();
  const checkpointId = newId();
  cleanup.push(runId);
  await seedRun(db, runId, "checkpoint resolution test");
  await db.execute(sql`UPDATE research_runs SET status = 'WAITING_HUMAN' WHERE id = ${runId}`);
  let failedTaskId: string | null = null;
  if (failedTaskType) {
    failedTaskId = newId();
    await seedTask(db, {
      id: failedTaskId,
      runId,
      status: "FAILED",
      type: failedTaskType,
      title: failedTaskType,
    });
  }
  await insertHumanCheckpoint(db, {
    id: checkpointId,
    runId,
    taskId: failedTaskId,
    reason,
    question: "what now?",
  });
  return { runId, checkpointId, failedTaskId };
}

async function runStatusOf(runId: string): Promise<string> {
  const rows = await db.execute(sql`SELECT status FROM research_runs WHERE id = ${runId}`);
  return String([...rows][0]?.status);
}

describe("resolveCheckpoint", () => {
  it("retry on analysis_failed: failed task retired, fresh analyze task, run ANALYZING", async () => {
    const { runId, checkpointId, failedTaskId } = await seedParkedRun("analysis_failed", "analyze");
    const res = await resolveCheckpoint(db, { runId, checkpointId, action: "retry", note: "go" });
    expect(res.action).toBe("retry");
    expect(res.createdTaskIds).toHaveLength(1);
    expect(await runStatusOf(runId)).toBe("ANALYZING");
    const old = [
      ...(await db.execute(sql`SELECT status FROM research_tasks WHERE id = ${failedTaskId}`)),
    ];
    expect(old[0]?.status).toBe("CANCELLED"); // human retirement (FAILED → CANCELLED)
    const fresh = [
      ...(await db.execute(sql`
        SELECT type, status, input FROM research_tasks
        WHERE id = ${res.createdTaskIds[0]}`)),
    ];
    expect(fresh[0]?.type).toBe("analyze");
    expect((fresh[0]?.input as Record<string, unknown> | undefined)?.humanRetry).toBe(true);
    const cp = [
      ...(await db.execute(
        sql`SELECT status, response FROM human_checkpoints WHERE id = ${checkpointId}`,
      )),
    ];
    expect(cp[0]?.status).toBe("resolved");
    expect((cp[0]?.response as Record<string, unknown> | undefined)?.action).toBe("retry");
    const events = [
      ...(await db.execute(sql`
        SELECT kind FROM events WHERE run_id = ${runId} AND type = 'CHECKPOINT_RESOLVED'`)),
    ];
    expect(events[0]?.kind).toBe("gate");
    const dr = [
      ...(await db.execute(sql`
        SELECT decision, rationale FROM decision_records
        WHERE run_id = ${runId} AND type = 'human_checkpoint'`)),
    ];
    expect(dr[0]).toMatchObject({ decision: "retry", rationale: "go" });
  });

  it("retry on synthesis_failed: fresh synthesize task, run SYNTHESIZING", async () => {
    const { runId, checkpointId } = await seedParkedRun("synthesis_failed", "synthesize");
    const res = await resolveCheckpoint(db, { runId, checkpointId, action: "retry" });
    expect(await runStatusOf(runId)).toBe("SYNTHESIZING");
    const fresh = [
      ...(await db.execute(
        sql`SELECT type FROM research_tasks WHERE id = ${res.createdTaskIds[0]}`,
      )),
    ];
    expect(fresh[0]?.type).toBe("synthesize");
  });

  it("accept on cycle_guard: human evaluation recorded, synthesize enqueued, run SYNTHESIZING", async () => {
    const { runId, checkpointId } = await seedParkedRun("cycle_guard", null);
    const res = await resolveCheckpoint(db, {
      runId,
      checkpointId,
      action: "accept",
      note: "good enough",
      actor: "eric",
    });
    expect(res.createdTaskIds).toHaveLength(1);
    expect(await runStatusOf(runId)).toBe("SYNTHESIZING");
    const evals = [
      ...(await db.execute(sql`
        SELECT evaluator_type, evaluator_name, decision, reasons FROM evaluations
        WHERE run_id = ${runId} AND target_type = 'run'`)),
    ];
    expect(evals[0]).toMatchObject({
      evaluator_type: "human",
      evaluator_name: "eric",
      decision: "ACCEPT",
    });
    expect((evals[0]?.reasons as string[] | undefined)?.[0]).toBe("good enough");
  });

  it("stop: run CANCELLED with its non-terminal tasks", async () => {
    const { runId, checkpointId } = await seedParkedRun("evaluator_escalation", null);
    await seedTask(db, { id: newId(), runId, status: "READY", type: "research", title: "r" });
    const res = await resolveCheckpoint(db, { runId, checkpointId, action: "stop" });
    expect(res).toEqual({ action: "stop", createdTaskIds: [] });
    expect(await runStatusOf(runId)).toBe("CANCELLED");
    const tasks = [
      ...(await db.execute(sql`SELECT status FROM research_tasks WHERE run_id = ${runId}`)),
    ];
    expect(tasks.every((t) => t.status === "CANCELLED")).toBe(true);
  });

  it("rejects illegal combinations and double resolution", async () => {
    const guard = await seedParkedRun("cycle_guard", null);
    await expect(
      resolveCheckpoint(db, {
        runId: guard.runId,
        checkpointId: guard.checkpointId,
        action: "retry",
      }),
    ).rejects.toThrow(CategorizedError);

    const failed = await seedParkedRun("analysis_failed", "analyze");
    await expect(
      resolveCheckpoint(db, {
        runId: failed.runId,
        checkpointId: failed.checkpointId,
        action: "accept",
      }),
    ).rejects.toThrow(/only valid for a cycle_guard/);

    // Wrong run id → not found.
    await expect(
      resolveCheckpoint(db, {
        runId: guard.runId,
        checkpointId: failed.checkpointId,
        action: "stop",
      }),
    ).rejects.toThrow(/does not exist/);

    // Resolve once, then again → already resolved.
    await resolveCheckpoint(db, {
      runId: failed.runId,
      checkpointId: failed.checkpointId,
      action: "retry",
    });
    await expect(
      resolveCheckpoint(db, {
        runId: failed.runId,
        checkpointId: failed.checkpointId,
        action: "stop",
      }),
    ).rejects.toThrow(/already resolved/);
  });
});
