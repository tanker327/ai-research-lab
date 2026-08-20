// Phase 6 gate, scripted leg (implementation-plan §6 P6, phase-6-plan D7).
//
//   1. A live run starts; MID-RUN the api process (which hosts the scheduler)
//      is killed and restarted — the run must complete anyway (ADR-017: the
//      console and control plane hold no state the database doesn't).
//   2. After the restart, a SUPERSEDED/REJECTED attempt's trace is fetched
//      through the fresh api and must assemble the full §24.2 block sequence.
//   3. /metrics serves the dashboard; the SSE stream carries default
//      `message` frames (6.3) so the timeline can never freeze again.
//
// The gate's other leg is human: watch a live run end-to-end in the console
// with the user. This script does not replace it.
//
// Usage: bun run gate:p6   (live — spends a few cents)
import { createDb, seedAttempt, seedRun, seedTask } from "@lab/db";
import { newId } from "@lab/schemas";

const API_PORT = 8795;
const BASE = `http://localhost:${API_PORT}`;
const baseEnv = {
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://lab:lab@localhost:5434/research_lab",
  ARTIFACT_ROOT: process.env.ARTIFACT_ROOT ?? "./data/artifacts",
  API_PORT: String(API_PORT),
  POLL_INTERVAL_MS: "300",
  TASK_CLAIM_TIMEOUT_S: "300",
  STALE_SWEEP_INTERVAL_MS: "5000",
  RESEARCHER_MAX_TOOL_CALLS: "5",
  MIN_EVIDENCE_PER_TASK: "1",
  MAX_PLAN_STAGES: "1",
  DEFAULT_MAX_EVAL_CYCLES: "3",
};

const { db, sql, close } = createDb(baseEnv.DATABASE_URL);

let api: Bun.Subprocess | null = null;
let workers: Bun.Subprocess[] = [];
function startApi(): Bun.Subprocess {
  api = Bun.spawn(["bun", "apps/api/src/index.ts"], {
    env: baseEnv,
    stdout: "ignore",
    stderr: "inherit",
  });
  return api;
}
function startWorkers(): void {
  for (const id of ["gate6-wA", "gate6-wB"]) {
    workers.push(
      Bun.spawn(["bun", "apps/worker/src/main.ts"], {
        env: { ...baseEnv, WORKER_ID: id },
        stdout: "ignore",
        stderr: "inherit",
      }),
    );
  }
}
function stopAll(): void {
  api?.kill();
  api = null;
  for (const w of workers) w.kill();
  workers = [];
}

async function until<T>(what: string, fn: () => Promise<T | null>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let v: T | null = null;
    try {
      v = await fn();
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("GATE ASSERTION FAILED")) throw err;
    }
    if (v !== null) return v;
    await Bun.sleep(1500);
  }
  throw new Error(`gate timeout waiting for: ${what}`);
}

function fail(msg: string): never {
  throw new Error(`GATE ASSERTION FAILED: ${msg}`);
}

async function waitApi(): Promise<void> {
  await until(
    "api /health",
    async () => ((await fetch(`${BASE}/health`).catch(() => null))?.ok ? true : null),
    30_000,
  );
}

const runIds: string[] = [];
try {
  let apiProc = startApi();
  startWorkers();
  await waitApi();

  console.log("— live run starts; api restarts mid-run (ADR-017)");
  const res = await fetch(`${BASE}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "phase-6 gate",
      userRequest:
        "Does PostgreSQL support transactional DDL? A concise answer from the primary " +
        "source below is fully sufficient — plan a single research task and do not " +
        "survey additional publishers. Primary source (content page, not a TOC): " +
        "https://wiki.postgresql.org/wiki/Transactional_DDL_in_PostgreSQL:_A_Competitive_Analysis",
    }),
  });
  if (res.status !== 201) fail(`POST /runs → ${res.status}`);
  const runId = ((await res.json()) as { id: string }).id;
  runIds.push(runId);

  // Wait for real progress (≥1 model call), then SIGTERM the api+scheduler.
  await until(
    "first model call of the run",
    async () => {
      const rows = await sql`SELECT count(*)::int AS n FROM model_calls WHERE run_id = ${runId}`;
      return ((rows[0]?.n as number) ?? 0) > 0 ? true : null;
    },
    10 * 60_000,
  );
  apiProc.kill();
  await Bun.sleep(2000);
  apiProc = startApi();
  void apiProc;
  await waitApi();
  console.log("  ✓ api killed after first model call and restarted; run continues");

  await until(
    "run COMPLETED through the restarted stack",
    async () => {
      const rows = await sql`SELECT status FROM research_runs WHERE id = ${runId}`;
      const s = String(rows[0]?.status);
      if (s === "FAILED" || s === "CANCELLED") fail(`run ended ${s}`);
      if (s === "WAITING_HUMAN") fail("run parked at a checkpoint instead of completing");
      return s === "COMPLETED" ? true : null;
    },
    45 * 60_000,
  );
  console.log("  ✓ run COMPLETED across the restart");

  // A superseded/rejected attempt's trace must assemble through the fresh
  // api. A clean run may have none — a fixture attempt in a fixture run
  // exercises the same read path (the trace is a pure DB projection).
  let target = (
    await sql`
      SELECT id, run_id FROM attempts
      WHERE run_id = ${runId} AND status IN ('SUPERSEDED','REJECTED') LIMIT 1`
  )[0] as { id: string; run_id: string } | undefined;
  if (!target) {
    const fxRun = newId();
    const fxTask = newId();
    const fxAttempt = newId();
    runIds.push(fxRun);
    await seedRun(db, fxRun, "phase-6 gate fixture (superseded trace)");
    await seedTask(db, { id: fxTask, runId: fxRun, status: "DONE", type: "research", title: "t" });
    await seedAttempt(db, {
      id: fxAttempt,
      taskId: fxTask,
      runId: fxRun,
      status: "SUPERSEDED",
      output: { note: "superseded fixture" },
    });
    target = { id: fxAttempt, run_id: fxRun };
    console.log("  · no superseded attempt in the live run — using a fixture (same read path)");
  }
  const traceRes = await fetch(`${BASE}/runs/${target.run_id}/attempts/${target.id}/trace`);
  if (!traceRes.ok) fail(`trace fetch after restart → ${traceRes.status}`);
  const trace = (await traceRes.json()) as {
    attempt: { status: string };
    blocks: Array<{ kind: string }>;
  };
  if (trace.blocks[0]?.kind !== "context_in") fail("trace does not open with context_in");
  if (!trace.blocks.some((b) => b.kind === "output")) fail("trace missing output block");
  console.log(
    `  ✓ ${trace.attempt.status} attempt's trace assembles after restart (${trace.blocks.length} blocks)`,
  );

  // Dashboard metrics (6.2).
  const metrics = (await (await fetch(`${BASE}/runs/${runId}/metrics`)).json()) as Record<
    string,
    number
  >;
  if (!metrics.modelCalls || metrics.modelCalls < 1) fail("metrics: no model calls counted");
  if (!metrics.evalCycles || metrics.evalCycles < 1) fail("metrics: no eval cycles counted");
  if (!metrics.maxEvalCycles) fail("metrics: maxEvalCycles missing");
  console.log(
    `  ✓ metrics: ${metrics.modelCalls} calls (${metrics.frontierCalls} frontier) · ${metrics.evalCycles}/${metrics.maxEvalCycles} cycles · ${metrics.liveEvidence} evidence`,
  );

  // SSE default frames (6.3): the replayed history must carry frames WITHOUT
  // an event name — what es.onmessage receives.
  const controller = new AbortController();
  const stream = await fetch(`${BASE}/runs/${runId}/events/stream`, {
    signal: controller.signal,
  });
  const reader = stream.body?.getReader();
  if (!reader) fail("no SSE body");
  let buffer = "";
  let sawDefault = false;
  let sawNamed = false;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !(sawDefault && sawNamed)) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += new TextDecoder().decode(value, { stream: true });
    for (const block of buffer.split("\n\n")) {
      if (!block.includes("data:")) continue;
      if (block.includes("event:")) sawNamed = true;
      else sawDefault = true;
    }
  }
  controller.abort();
  await reader.cancel().catch(() => {});
  if (!sawNamed || !sawDefault) {
    fail(`SSE frames incomplete (named=${sawNamed}, default=${sawDefault})`);
  }
  console.log("  ✓ SSE carries named + default message frames");

  console.log("✓ Phase 6 gate (scripted leg) passed — remaining: watch a live run with the user");
} finally {
  stopAll();
  if (process.env.GATE_KEEP_RUN !== "1") {
    for (const id of runIds) await sql`DELETE FROM research_runs WHERE id = ${id}`;
  }
  await close();
}
