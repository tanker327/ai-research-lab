// Golden research task runner (phase-8-plan D1/D2) — the §7 regression suite.
//
//   bun run golden <ID>                          run a golden live, write baseline
//   bun run golden <ID> --judge pass|fail [--note "…"]   stamp the human verdict
//
// Run mode reuses the gate pattern (own port, own stack, real system defaults —
// no MAX_PLAN_STAGES shortcuts: goldens exercise staged planning). The run is
// ALWAYS kept: the human verdict is a read of the actual report in the console,
// and the baseline records the runId to open. Exit code is non-zero when a hard
// assertion fails (budgets, contested/checkpoint expectations, silent
// cycle-guard breach); soft cycle drift lands in the baseline as a divergence.
//
// Baselines are committed JSON under scripts/golden/baselines/<id>/ — the git
// log of that directory IS the regression history; before any prompt-version
// bump the suite reruns and the diff against the last baseline is the review
// artifact (design §33).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createDb } from "@lab/db";
import {
  buildBaseline,
  type CollectedMetrics,
  type CollectedRun,
  countChips,
  evaluateExpectations,
  type GoldenBaseline,
} from "./assertions";
import { GOLDEN_TASKS } from "./tasks";

const BASELINE_ROOT = join(import.meta.dir, "baselines");
const API_PORT = 8795;
const BASE = `http://localhost:${API_PORT}`;

// ---------------------------------------------------------------- CLI parsing

const argv = process.argv.slice(2);
const goldenId = argv[0];
if (!goldenId || goldenId.startsWith("--")) usage("missing golden task id");
const golden = GOLDEN_TASKS[goldenId];
if (!golden)
  usage(
    `unknown golden '${goldenId}' — known: ${Object.keys(GOLDEN_TASKS).join(", ") || "(none defined yet)"}`,
  );

const judgeIdx = argv.indexOf("--judge");
const judgeVerdict = judgeIdx >= 0 ? argv[judgeIdx + 1] : null;
const noteIdx = argv.indexOf("--note");
const judgeNote = noteIdx >= 0 ? (argv[noteIdx + 1] ?? null) : null;

function usage(problem: string): never {
  console.error(`golden: ${problem}`);
  console.error('usage: bun run golden <ID> [--judge pass|fail [--note "…"]]');
  process.exit(2);
}

if (judgeIdx >= 0) {
  if (judgeVerdict !== "pass" && judgeVerdict !== "fail") usage("--judge takes pass|fail");
  stampVerdict(golden.id, judgeVerdict, judgeNote);
  process.exit(0);
}

// ------------------------------------------------------------- judge stamping

function baselineDir(id: string): string {
  return join(BASELINE_ROOT, id);
}

function latestBaselinePath(id: string): string | null {
  let files: string[];
  try {
    files = readdirSync(baselineDir(id)).filter((f) => f.endsWith(".json"));
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  files.sort(); // date-named files: lexicographic = chronological
  return join(baselineDir(id), files[files.length - 1] as string);
}

function stampVerdict(id: string, verdict: "pass" | "fail", note: string | null): void {
  const path = latestBaselinePath(id);
  if (!path) {
    console.error(`golden: no baseline recorded for ${id} — run it first`);
    process.exit(2);
  }
  const baseline = JSON.parse(readFileSync(path, "utf8")) as GoldenBaseline;
  baseline.humanVerdict = verdict;
  baseline.humanNote = note;
  baseline.judgedAt = new Date().toISOString();
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`);
  biomeFormat(path);
  console.log(`✓ ${id} judged ${verdict}${note ? ` — ${note}` : ""} (${path})`);
  console.log("  commit the baseline: the git log is the regression history.");
}

// ------------------------------------------------------------------ run mode

const baseEnv = {
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://lab:lab@localhost:5434/research_lab",
  ARTIFACT_ROOT: process.env.ARTIFACT_ROOT ?? "./data/artifacts",
  API_PORT: String(API_PORT),
  POLL_INTERVAL_MS: "300",
  STALE_SWEEP_INTERVAL_MS: "5000",
};
const MAX_EVAL_CYCLES = Number(process.env.DEFAULT_MAX_EVAL_CYCLES ?? 3);

const { sql, close } = createDb(baseEnv.DATABASE_URL);

let children: Bun.Subprocess[] = [];
function startStack(): void {
  children.push(
    Bun.spawn(["bun", "apps/api/src/index.ts"], {
      env: baseEnv,
      stdout: "ignore",
      stderr: "inherit",
    }),
  );
  for (const id of ["golden-wA", "golden-wB"]) {
    children.push(
      Bun.spawn(["bun", "apps/worker/src/main.ts"], {
        env: { ...baseEnv, WORKER_ID: id },
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

async function api<T>(path: string, init?: RequestInit): Promise<T | null> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (res.status === 404) return null;
  if (!res.ok)
    throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function collect(runId: string): Promise<CollectedRun> {
  const run = await api<{ status: string }>(`/runs/${runId}`);
  const metrics = await api<CollectedMetrics>(`/runs/${runId}/metrics`);
  if (!run || !metrics) throw new Error("run/metrics unreadable after the wait");
  const checkpoints = (await api<Array<{ reason: string }>>(`/runs/${runId}/checkpoints`)) ?? [];
  const guardEvents = await sql`
    SELECT count(*)::int AS n FROM events
    WHERE run_id = ${runId} AND type = 'CYCLE_GUARD_TRIPPED'`;
  const verdictRows = await sql`
    SELECT decision, reasons, metadata->>'cycle' AS cycle FROM evaluations
    WHERE run_id = ${runId} AND target_type = 'run' AND evaluator_type = 'agent'
    ORDER BY created_at`;
  const report = await api<{ title: string | null; markdown: string | null }>(
    `/runs/${runId}/report`,
  );
  return {
    runId,
    runStatus: run.status,
    metrics,
    maxEvalCycles: MAX_EVAL_CYCLES,
    checkpointReasons: [...new Set(checkpoints.map((c) => c.reason))],
    cycleGuardEvents: (guardEvents[0]?.n as number) ?? 0,
    verdicts: verdictRows.map((r) => ({
      cycle: Number(r.cycle ?? 0),
      decision: String(r.decision),
      reasons: (r.reasons as string[] | null) ?? [],
    })),
    report: report ? { title: report.title, chipCount: countChips(report.markdown ?? "") } : null,
  };
}

function writeBaseline(baseline: GoldenBaseline): string {
  const dir = baselineDir(baseline.goldenId);
  mkdirSync(dir, { recursive: true });
  let path = join(dir, `${baseline.date}.json`);
  try {
    readFileSync(path); // already ran today — keep both records
    const t = new Date().toISOString().slice(11, 19).replaceAll(":", "");
    path = join(dir, `${baseline.date}-${t}.json`);
  } catch {
    // first run of the day
  }
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`);
  biomeFormat(path);
  return path;
}

// Baselines are committed — keep them lint-clean without a manual pass.
function biomeFormat(path: string): void {
  Bun.spawnSync(["bunx", "biome", "check", "--write", path], {
    stdout: "ignore",
    stderr: "ignore",
  });
}

try {
  console.log(`golden ${golden.id}: ${golden.title}`);
  console.log(
    `  budgets: ≤$${golden.expectations.budgetUsd.toFixed(2)} frontier, ` +
      `≤${golden.expectations.wallClockMin}min`,
  );
  startStack();
  const healthDeadline = Date.now() + 30_000;
  while (!(await fetch(`${BASE}/health`).catch(() => null))?.ok) {
    if (Date.now() > healthDeadline) throw new Error("api never became healthy");
    await Bun.sleep(500);
  }

  const created = await api<{ id: string }>("/runs", {
    method: "POST",
    body: JSON.stringify({ title: `golden ${golden.id}`, userRequest: golden.userRequest }),
  });
  if (!created) throw new Error("run creation returned 404");
  const runId = created.id;
  console.log(`  run ${runId} — waiting (≤${golden.expectations.wallClockMin}min + grace)`);

  // Wait until the run reaches a state a human could act on: terminal, or
  // parked at any checkpoint (WAITING_HUMAN never resolves itself). The
  // expected-vs-actual reading of that state is evaluateExpectations' job.
  const deadline = Date.now() + (golden.expectations.wallClockMin * 60 + 120) * 1000;
  let lastStatus = "";
  while (Date.now() < deadline) {
    const r = await api<{ status: string }>(`/runs/${runId}`);
    const status = r?.status ?? "unknown";
    if (status !== lastStatus) {
      console.log(`  … ${status}`);
      lastStatus = status;
    }
    if (["COMPLETED", "FAILED", "CANCELLED", "WAITING_HUMAN"].includes(status)) break;
    await Bun.sleep(3000);
  }

  const collected = await collect(runId);
  const result = evaluateExpectations(golden.expectations, collected);
  const baseline = buildBaseline({
    goldenId: golden.id,
    title: golden.title,
    date: new Date().toISOString().slice(0, 10),
    expectations: golden.expectations,
    collected,
    result,
  });
  const path = writeBaseline(baseline);

  const m = collected.metrics;
  console.log(`  run ended ${collected.runStatus}`);
  console.log(
    `  cycles ${m.evalCycles}/${MAX_EVAL_CYCLES} · retries ${m.intelligenceRetries} ` +
      `(escalations ${m.tierEscalations}) · claims ${m.liveClaims} ` +
      `(${m.contestedClaims} contested) · evidence ${m.liveEvidence}`,
  );
  console.log(
    `  frontier ${m.frontierCalls}/${m.modelCalls} calls, ` +
      `$${(m.frontierSpendUsd ?? 0).toFixed(4)} · wall ${m.wallClockSeconds}s`,
  );
  if (collected.report) {
    console.log(`  report: "${collected.report.title}" (${collected.report.chipCount} chips)`);
  }
  for (const d of result.divergences) console.log(`  ~ divergence: ${d}`);
  for (const f of result.failures) console.log(`  ✗ ${f}`);
  console.log(`  baseline: ${path} (humanVerdict pending)`);
  console.log(
    `  next: read the report at http://localhost:5173/#/run/${runId}/report, then\n` +
      `        bun run golden ${golden.id} --judge pass|fail --note "…"`,
  );

  if (result.failures.length > 0) {
    console.error(`✗ golden ${golden.id}: ${result.failures.length} assertion(s) failed`);
    // exitCode, never process.exit(): exit() skips the finally and orphans
    // the stack on port 8795 (found live — G2 couldn't bind after a failed G1).
    process.exitCode = 1;
  } else {
    console.log(`✓ golden ${golden.id}: all hard assertions green — awaiting human verdict`);
  }
} finally {
  stopStack();
  await close();
}
