// Ticket 1.4 acceptance against real Postgres: the transactional counterpart
// of the migration-level idx_attempts_one_accepted tests — atomic supersede,
// live-view flip, and a concurrent double-accept losing at commit.
import { createDb, deleteRun, insertFakeEvidence, seedRun, seedTask } from "@lab/db";
import { newId } from "@lab/schemas";
import postgres from "postgres";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { acceptAttempt } from "./liveness";
import { InvalidTransitionError } from "./state/machine";

const url = process.env.DATABASE_URL ?? "postgres://lab:lab@localhost:5434/research_lab";
const clientA = createDb(url);
const clientB = createDb(url);
const raw = postgres(url);

let runId: string;
let taskId: string;

beforeEach(async () => {
  runId = newId();
  taskId = newId();
  await seedRun(clientA.db, runId);
  await seedTask(clientA.db, { id: taskId, runId, status: "EVALUATING" });
});

afterEach(async () => {
  await deleteRun(clientA.db, runId);
});

afterAll(async () => {
  await clientA.close();
  await clientB.close();
  await raw.end();
});

async function seedAttempt(status: string, attemptNumber: number): Promise<string> {
  const id = newId();
  await raw`INSERT INTO attempts (id, task_id, run_id, attempt_number, status, agent_name, agent_version)
            VALUES (${id}, ${taskId}, ${runId}, ${attemptNumber}, ${status}, 'fake', 'v1')`;
  return id;
}

describe("acceptAttempt", () => {
  it("accepts a SUCCEEDED attempt and supersedes prior SUCCEEDED/FAILED/REJECTED atomically", async () => {
    const failed = await seedAttempt("FAILED", 1);
    const rejectedA = await seedAttempt("REJECTED", 2);
    const oldSucceeded = await seedAttempt("SUCCEEDED", 3);
    const winner = await seedAttempt("SUCCEEDED", 4);
    const cancelled = await seedAttempt("CANCELLED", 5);

    const result = await acceptAttempt(clientA.db, winner);
    expect(result.taskId).toBe(taskId);
    expect(result.supersededAttemptIds.sort()).toEqual([failed, rejectedA, oldSucceeded].sort());

    const rows = await raw`SELECT id, status FROM attempts WHERE task_id = ${taskId}`;
    const byId = new Map(rows.map((r) => [r.id, r.status]));
    expect(byId.get(winner)).toBe("ACCEPTED");
    expect(byId.get(failed)).toBe("SUPERSEDED");
    expect(byId.get(rejectedA)).toBe("SUPERSEDED");
    expect(byId.get(oldSucceeded)).toBe("SUPERSEDED");
    expect(byId.get(cancelled)).toBe("CANCELLED"); // terminal — untouched

    const [task] = await raw`SELECT status, completed_at FROM research_tasks WHERE id = ${taskId}`;
    expect(task?.status).toBe("DONE");
    expect(task?.completed_at).not.toBeNull();

    const events = await raw`SELECT type, kind FROM events WHERE run_id = ${runId} ORDER BY id`;
    expect(events.map((e) => e.type)).toEqual(["CANONICALIZATION_ENQUEUED", "ATTEMPT_ACCEPTED"]);
    expect(events[1]?.kind).toBe("accept");
  });

  it("flips live_evidence in the same transaction — only the accepted attempt's rows are live", async () => {
    const loser = await seedAttempt("FAILED", 1);
    const winner = await seedAttempt("SUCCEEDED", 2);
    await insertFakeEvidence(clientA.db, {
      id: newId(),
      runId,
      taskId,
      attemptId: loser,
      excerpt: "from the dead attempt",
    });
    await insertFakeEvidence(clientA.db, {
      id: newId(),
      runId,
      taskId,
      attemptId: winner,
      excerpt: "from the winner",
    });

    expect(await raw`SELECT * FROM live_evidence WHERE task_id = ${taskId}`).toHaveLength(0);
    await acceptAttempt(clientA.db, winner);
    const live = await raw`SELECT excerpt, attempt_id FROM live_evidence WHERE task_id = ${taskId}`;
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ excerpt: "from the winner", attempt_id: winner });
  });

  it.each(["FAILED", "REJECTED", "SUPERSEDED", "RUNNING", "CANCELLED"])(
    "refuses to accept a %s attempt",
    async (status) => {
      const id = await seedAttempt(status, 1);
      await expect(acceptAttempt(clientA.db, id)).rejects.toThrow(InvalidTransitionError);
    },
  );

  it("second accept after a completed accept fails — the first supersede already retired it", async () => {
    const first = await seedAttempt("SUCCEEDED", 1);
    const second = await seedAttempt("SUCCEEDED", 2);
    await acceptAttempt(clientA.db, first);
    await expect(acceptAttempt(clientA.db, second)).rejects.toThrow(InvalidTransitionError);
  });

  it("concurrent double-accept: exactly one wins at commit", async () => {
    const a = await seedAttempt("SUCCEEDED", 1);
    const b = await seedAttempt("SUCCEEDED", 2);

    const results = await Promise.allSettled([
      acceptAttempt(clientA.db, a),
      acceptAttempt(clientB.db, b),
    ]);
    const wins = results.filter((r) => r.status === "fulfilled");
    expect(wins).toHaveLength(1);

    const rows = await raw`SELECT status FROM attempts WHERE task_id = ${taskId}`;
    const statuses = rows.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === "ACCEPTED")).toHaveLength(1);
    expect(statuses.filter((s) => s === "SUPERSEDED")).toHaveLength(1);
    const [task] = await raw`SELECT status FROM research_tasks WHERE id = ${taskId}`;
    expect(task?.status).toBe("DONE");
  });
});
