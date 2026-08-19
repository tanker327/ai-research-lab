// Phase 1 gate (implementation-plan §6, phase-1-plan Session D). Scripted
// torture: create run → 5 fake tasks with a dependency chain → 2 real worker
// processes → SIGKILL the worker holding the victim task mid-write → stale
// claim releases → retry ladder re-runs it → run COMPLETED. Asserts:
//   1. no duplicate live side-effect rows (dead attempt's row stays dark)
//   2. every task transition in the event log replays legally
//   3. the event log alone tells the story (required beats present)
// GATE_PG_RESTART=1 additionally restarts Postgres mid-run (matrix row 7).
import { assertTaskTransition } from "@lab/core";
import { createDb } from "@lab/db";
import { newId, type TaskStatus } from "@lab/schemas";

const API_PORT = 8791;
const BASE = `http://localhost:${API_PORT}`;
const env = {
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://lab:lab@localhost:5434/research_lab",
  AIHUB_BASE_URL: process.env.AIHUB_BASE_URL ?? "http://ai-hub.local:3000/v1",
  MODEL_FRONTIER: "gate",
  MODEL_STRONG_LOCAL: "gate",
  MODEL_FAST_LOCAL: "gate",
  API_PORT: String(API_PORT),
  POLL_INTERVAL_MS: "200",
  // Must exceed the victim's 4s handler duration, or every honest retry
  // expires mid-work (the runaway loop this gate caught on its first run).
  TASK_CLAIM_TIMEOUT_S: "6",
  STALE_SWEEP_INTERVAL_MS: "1000",
};

const children: Bun.Subprocess[] = [];
function spawn(cmd: string[], extra: Record<string, string> = {}): Bun.Subprocess {
  const proc = Bun.spawn(cmd, { env: { ...env, ...extra }, stdout: "ignore", stderr: "inherit" });
  children.push(proc);
  return proc;
}

const { db, sql, close } = createDb(env.DATABASE_URL);

async function until<T>(what: string, fn: () => Promise<T | null>, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn().catch(() => null);
    if (v !== null) return v;
    await Bun.sleep(250);
  }
  throw new Error(`gate timeout waiting for: ${what}`);
}

function fail(msg: string): never {
  throw new Error(`GATE ASSERTION FAILED: ${msg}`);
}

try {
  // 1. api + two workers
  spawn(["bun", "apps/api/src/index.ts"]);
  await until("api /health", async () =>
    (await fetch(`${BASE}/health`).catch(() => null))?.ok ? true : null,
  );
  const workers = new Map<string, Bun.Subprocess>();
  for (const id of ["gate-wA", "gate-wB"]) {
    workers.set(id, spawn(["bun", "apps/worker/src/main.ts"], { WORKER_ID: id }));
  }

  // 2. run with a 5-task dependency chain; the victim writes evidence then
  // sleeps — the SIGKILL lands inside that window.
  const victim = newId();
  const [b, c, d, e] = [newId(), newId(), newId(), newId()];
  const createRes = await fetch(`${BASE}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "phase-1 gate",
      userRequest: "gate torture run",
      tasks: [
        {
          id: victim,
          type: "research",
          title: "victim (killed mid-write)",
          input: { fake: { behavior: "side_effect", excerpt: "gate-evidence", sleepMs: 4000 } },
        },
        {
          id: b,
          type: "extract",
          title: "b after victim",
          input: { fake: { behavior: "sleep", ms: 50 } },
          dependsOn: [victim],
        },
        {
          id: c,
          type: "analyze",
          title: "c after b",
          input: { fake: { behavior: "side_effect", excerpt: "c-evidence" } },
          dependsOn: [b],
        },
        {
          id: d,
          type: "research",
          title: "d independent",
          input: { fake: { behavior: "sleep", ms: 30 } },
        },
        {
          id: e,
          type: "research",
          title: "e independent",
          input: { fake: { behavior: "sleep", ms: 30 } },
        },
      ],
    }),
  });
  if (createRes.status !== 201) fail(`POST /runs → ${createRes.status}`);
  const { id: runId } = (await createRes.json()) as { id: string };
  console.log(`→ run ${runId} created; waiting for the victim to be claimed`);

  // 3. SIGKILL the worker that claimed the victim, mid-attempt.
  const claimedBy = await until("victim claimed", async () => {
    const [row] = await sql`SELECT claimed_by FROM research_tasks
                            WHERE id = ${victim} AND status = 'RUNNING'`;
    return (row?.claimed_by as string) ?? null;
  });
  const doomed = workers.get(claimedBy);
  if (!doomed) fail(`victim claimed by unknown worker ${claimedBy}`);
  doomed.kill(9);
  console.log(`→ SIGKILLed ${claimedBy} mid-attempt (matrix row 1)`);

  if (process.env.GATE_PG_RESTART === "1") {
    console.log("→ restarting Postgres mid-run (matrix row 7)");
    await Bun.$`docker restart lab-postgres`.quiet();
  }

  // 4. the engine recovers on its own: stale release → ladder retry → accept.
  await until(
    "run COMPLETED",
    async () => {
      const res = await fetch(`${BASE}/runs/${runId}`);
      if (!res.ok) return null;
      const run = (await res.json()) as { status: string };
      if (run.status === "FAILED" || run.status === "CANCELLED") fail(`run ended ${run.status}`);
      return run.status === "COMPLETED" ? true : null;
    },
    120_000,
  );
  console.log("→ run COMPLETED; asserting invariants");

  // Assertion 1: no duplicate live rows. Both victim attempts wrote evidence;
  // exactly one row (the accepted attempt's) is live.
  const victimEvidence =
    await sql`SELECT count(*)::int AS n FROM evidence WHERE task_id = ${victim}`;
  const victimLive = await sql`
    SELECT e.attempt_id FROM live_evidence e WHERE e.task_id = ${victim}`;
  if ((victimEvidence[0]?.n as number) < 2)
    fail(`expected ≥2 evidence writes, got ${victimEvidence[0]?.n}`);
  if (victimLive.length !== 1)
    fail(`expected exactly 1 LIVE evidence row, got ${victimLive.length}`);
  const [accepted] =
    await sql`SELECT id FROM attempts WHERE task_id = ${victim} AND status = 'ACCEPTED'`;
  if (victimLive[0]?.attempt_id !== accepted?.id) fail("live row is not the accepted attempt's");
  console.log(`  ✓ no duplicate live rows (${victimEvidence[0]?.n} written, 1 live)`);

  // Assertion 2: replay every task transition in the event log through
  // assertTransition — the log must describe a legal history.
  const TO: Record<string, TaskStatus> = {
    TASK_READY: "READY",
    TASK_CLAIMED: "RUNNING",
    ATTEMPT_SUCCEEDED: "EVALUATING",
    ATTEMPT_FAILED: "EVALUATING",
    TASK_CLAIM_EXPIRED: "EVALUATING",
    TASK_RETRY: "READY",
    TASK_FAILED: "FAILED",
    TASK_BLOCKED: "BLOCKED",
    ATTEMPT_ACCEPTED: "DONE",
  };
  const events = await sql`SELECT task_id, type FROM events WHERE run_id = ${runId} ORDER BY id`;
  const status = new Map<string, TaskStatus>();
  let replayed = 0;
  for (const ev of events) {
    const to = TO[ev.type as string];
    if (!to || !ev.task_id) continue;
    const from = status.get(ev.task_id as string) ?? "CREATED";
    assertTaskTransition(from, to); // throws on an illegal history
    status.set(ev.task_id as string, to);
    replayed++;
  }
  for (const [taskId, s] of status) {
    if (s !== "DONE") fail(`task ${taskId} ended ${s} in the replayed event log`);
  }
  console.log(`  ✓ ${replayed} event-log transitions replay legally; all 5 tasks end DONE`);

  // Assertion 3: the event log alone tells the story — required beats.
  const types = new Set<string>();
  for (const ev of events) types.add(ev.type as string);
  for (const beat of [
    "RUN_CREATED",
    "TASK_CLAIMED",
    "TASK_CLAIM_EXPIRED", // the kill was seen (the sweep fails the attempt — no worker survives to report ATTEMPT_FAILED)
    "TASK_RETRY", // the ladder decided
    "ATTEMPT_ACCEPTED",
    "CANONICALIZATION_ENQUEUED",
    "RUN_COMPLETED",
  ]) {
    if (!types.has(beat)) fail(`event log is missing the '${beat}' beat`);
  }
  const decisions = await sql`SELECT count(*)::int AS n FROM decision_records
                              WHERE run_id = ${runId} AND type = 'retry_ladder'`;
  if ((decisions[0]?.n as number) < 1) fail("no DecisionRecord written for the retry");
  console.log("  ✓ event log carries the full story; retry DecisionRecord present");

  console.log("✓ Phase 1 gate passed");
} finally {
  for (const proc of children) proc.kill(9);
  await close();
}
