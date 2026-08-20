// Phase 4 gate (implementation-plan §6, phase-4-plan D7). LIVE, two legs:
//
//   A — THE MILESTONE: a question engineered to under-cover on stage-1 seeds.
//       The Evaluator must find the gap → core creates follow-up task(s) →
//       they execute → analysis v2 → ACCEPT on cycle ≥2 → run COMPLETED,
//       with per-cycle coverage persisted and strictly improved.
//   B — THE GUARD: an impossible success criterion with DEFAULT_MAX_EVAL_CYCLES=1.
//       Whatever non-ACCEPT decision the model picks, the deterministic guard
//       must trip: WAITING_HUMAN + cycle_guard checkpoint + fail event.
//
// Usage: bun run gate:p4   (spends a few cents — frontier evaluator calls)
import { createDb } from "@lab/db";

const API_PORT = 8793;
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
  MAX_PLAN_STAGES: "1", // stage-1 only: keeps runs small and the gap honest
};

const { sql, close } = createDb(baseEnv.DATABASE_URL);

let children: Bun.Subprocess[] = [];
function startStack(extra: Record<string, string>): void {
  const env = { ...baseEnv, ...extra };
  children.push(
    Bun.spawn(["bun", "apps/api/src/index.ts"], { env, stdout: "ignore", stderr: "inherit" }),
  );
  for (const id of ["gate4-wA", "gate4-wB"]) {
    children.push(
      Bun.spawn(["bun", "apps/worker/src/main.ts"], {
        env: { ...env, WORKER_ID: id },
        stdout: "ignore",
        stderr: "inherit",
      }),
    );
  }
}
function stopStack(): void {
  for (const c of children) c.kill();
  children = [];
}

async function until<T>(what: string, fn: () => Promise<T | null>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let v: T | null = null;
    try {
      v = await fn();
    } catch (err) {
      // Assertion failures must abort the leg — only transient errors poll on.
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

async function createRun(userRequest: string, title: string): Promise<string> {
  const res = await fetch(`${BASE}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title, userRequest }),
  });
  if (res.status !== 201) fail(`POST /runs → ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

async function runStatus(runId: string): Promise<string> {
  const rows = await sql`SELECT status FROM research_runs WHERE id = ${runId}`;
  return String(rows[0]?.status);
}

const runIds: string[] = [];
try {
  // ---------------- Leg B first: fast, deterministic guard trip ----------------
  console.log("— Leg B: cycle guard (cap=1, impossible rubric)");
  startStack({ DEFAULT_MAX_EVAL_CYCLES: "1" });
  await waitApi();
  // Live-gate finding (first run): a future-dated "impossible" criterion was
  // reasonably ACCEPTed as documented absence — the rubric must be MEASURABLY
  // unmet in coverage and explicitly forbid absence-acceptance.
  const runB = await createRun(
    "Does PostgreSQL support transactional DDL? " +
      "STRICT success criteria that MUST be verified against the coverage numbers: the " +
      "evidence base must span at least 12 distinct non-vendor publishers AND at least 5 " +
      "distinct benchmark origins. If the coverage does not meet these thresholds the " +
      "analysis MUST NOT be accepted — documented absence or accepted uncertainty does " +
      "NOT satisfy these thresholds. " +
      "Primary source (content page, not a TOC): " +
      "https://wiki.postgresql.org/wiki/Transactional_DDL_in_PostgreSQL:_A_Competitive_Analysis",
    "phase-4 gate leg B",
  );
  runIds.push(runB);
  await until(
    "leg B: run WAITING_HUMAN (guard) or terminal",
    async () => {
      const s = await runStatus(runB);
      if (s === "FAILED" || s === "CANCELLED") fail(`leg B run ended ${s} before the guard`);
      if (s === "COMPLETED") fail("leg B: evaluator ACCEPTed an impossible rubric (rubber-stamp)");
      return s === "WAITING_HUMAN" ? true : null;
    },
    25 * 60_000,
  );
  const cpB = await sql`
    SELECT reason, status FROM human_checkpoints WHERE run_id = ${runB}`;
  if (!cpB.some((r) => r.reason === "cycle_guard" && r.status === "pending")) {
    fail(`leg B: no pending cycle_guard checkpoint (got ${JSON.stringify(cpB)})`);
  }
  const tripB = await sql`
    SELECT kind FROM events WHERE run_id = ${runB} AND type = 'CYCLE_GUARD_TRIPPED'`;
  if (tripB[0]?.kind !== "fail") fail("leg B: CYCLE_GUARD_TRIPPED fail event missing");
  console.log("  ✓ guard tripped at cap: WAITING_HUMAN + cycle_guard checkpoint + fail event");
  stopStack();

  // ---------------- Leg A: THE MILESTONE ----------------
  console.log("— Leg A: the milestone (gap → follow-up → ACCEPT on cycle ≥2)");
  startStack({ DEFAULT_MAX_EVAL_CYCLES: "4" });
  await waitApi();
  const runA = await createRun(
    "Does PostgreSQL support transactional DDL, and — REQUIRED — how do DDL statements " +
      "behave inside two-phase commit (PREPARE TRANSACTION): which operations are " +
      "forbidden in a prepared transaction? Success requires evidence from the official " +
      "postgresql.org PREPARE TRANSACTION documentation specifically; general " +
      "transactional-DDL evidence alone is NOT sufficient. " +
      "Primary source to start from (content page, not a TOC): " +
      "https://wiki.postgresql.org/wiki/Transactional_DDL_in_PostgreSQL:_A_Competitive_Analysis",
    "phase-4 gate leg A",
  );
  runIds.push(runA);
  await until(
    "leg A: run COMPLETED",
    async () => {
      const s = await runStatus(runA);
      if (s === "FAILED" || s === "CANCELLED") fail(`leg A run ended ${s}`);
      if (s === "WAITING_HUMAN") fail("leg A: parked at a checkpoint instead of completing");
      return s === "COMPLETED" ? true : null;
    },
    45 * 60_000,
  );
  console.log("  ✓ run COMPLETED");

  // The loop actually looped: ≥2 cycles, at least one demand, follow-ups real.
  const verdicts = (await fetch(`${BASE}/runs/${runA}/verdicts`).then((r) => r.json())) as Array<{
    decision: string;
    metadata: { cycle?: number; coverage?: { evidenceCount: number; vendorRatio: number } };
  }>;
  if (verdicts.length < 2) fail(`leg A: expected ≥2 evaluator cycles, got ${verdicts.length}`);
  const demand = verdicts.find((v) => v.decision === "RESEARCH_MORE" || v.decision === "REPLAN");
  if (!demand) fail("leg A: no RESEARCH_MORE/REPLAN cycle — the gap was never demanded");
  const final = verdicts[verdicts.length - 1];
  if (final?.decision !== "ACCEPT") fail(`leg A: final decision ${final?.decision}, not ACCEPT`);
  if ((final.metadata.cycle ?? 0) < 2) fail("leg A: ACCEPT landed on cycle 1");
  console.log(
    `  ✓ ${verdicts.length} cycles: ${verdicts.map((v) => v.decision).join(" → ")} (ACCEPT on cycle ${final.metadata.cycle})`,
  );

  const followups = await sql`
    SELECT count(*)::int AS n FROM events WHERE run_id = ${runA} AND type = 'FOLLOWUP_TASK_CREATED'`;
  if (demand.decision === "RESEARCH_MORE" && ((followups[0]?.n as number) ?? 0) < 1) {
    fail("leg A: RESEARCH_MORE produced no FOLLOWUP_TASK_CREATED");
  }

  // Per-cycle coverage persisted (R13) and strictly improved by acceptance.
  for (const v of verdicts) {
    if (!v.metadata.coverage) fail("leg A: a verdict is missing metadata.coverage");
  }
  const c1 = demand.metadata.coverage;
  const cN = final.metadata.coverage;
  if (c1 && cN && !(cN.evidenceCount > c1.evidenceCount || cN.vendorRatio < c1.vendorRatio)) {
    fail(
      `leg A: coverage did not improve (evidence ${c1.evidenceCount}→${cN.evidenceCount}, vendor ${c1.vendorRatio}→${cN.vendorRatio})`,
    );
  }
  console.log(
    `  ✓ coverage persisted per cycle and improved: evidence ${c1?.evidenceCount}→${cN?.evidenceCount}`,
  );

  // Event beats of the loop.
  const beats = await sql`
    SELECT DISTINCT type FROM events WHERE run_id = ${runA}
    AND type IN ('ANALYZE_TASK_CREATED','ANALYSIS_ACCEPTED','EVALUATE_TASK_CREATED',
                 'EVALUATION_DECISION','FOLLOWUP_TASK_CREATED')`;
  const found = new Set(beats.map((b) => b.type as string));
  for (const beat of [
    "ANALYZE_TASK_CREATED",
    "ANALYSIS_ACCEPTED",
    "EVALUATE_TASK_CREATED",
    "EVALUATION_DECISION",
  ]) {
    if (!found.has(beat)) fail(`leg A: event log missing beat ${beat}`);
  }
  console.log(`  ✓ loop event beats (${[...found].join(", ")})`);

  console.log("✓ Phase 4 gate passed — THE MILESTONE holds");
} finally {
  stopStack();
  if (process.env.GATE_KEEP_RUN !== "1") {
    for (const id of runIds) await sql`DELETE FROM research_runs WHERE id = ${id}`;
  }
  await close();
}
