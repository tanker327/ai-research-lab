// Phase 3 gate (implementation-plan §6, phase-3-plan Session E). LIVE: real
// api + workers + deployed-hub local models drive a planner-created run end
// to end: stage-1 discovery → research notes → auto-created extracts →
// evidence/raw claims → canonicalized live claims → stage-2 plan task with
// FULLY CONCRETE inputs (ADR-011) → run COMPLETED. Asserts the R3 chain plus
// dedup (no duplicate live subject+predicate) and the console read surface.
// Usage: bun run gate:p3   (local models only — spends ~nothing; needs the
// hub reachable; SearXNG optional — the question ships seed URLs)
import { createDb } from "@lab/db";

const API_PORT = 8792;
const BASE = `http://localhost:${API_PORT}`;
const env = {
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://lab:lab@localhost:5434/research_lab",
  ARTIFACT_ROOT: process.env.ARTIFACT_ROOT ?? "./data/artifacts",
  API_PORT: String(API_PORT),
  POLL_INTERVAL_MS: "300",
  TASK_CLAIM_TIMEOUT_S: "300",
  STALE_SWEEP_INTERVAL_MS: "5000",
  RESEARCHER_MAX_TOOL_CALLS: "5",
  MIN_EVIDENCE_PER_TASK: "1", // one seeded doc page — don't demand breadth here
};

const PLACEHOLDER = /\{\{|\{%|<insert|<fill|\bTBD\b|\bTODO\b|\bPLACEHOLDER\b|\bFIXME\b/i;

const children: Bun.Subprocess[] = [];
function spawn(cmd: string[], extra: Record<string, string> = {}): void {
  children.push(Bun.spawn(cmd, { env: { ...env, ...extra }, stdout: "ignore", stderr: "inherit" }));
}

const { sql, close } = createDb(env.DATABASE_URL);

async function until<T>(what: string, fn: () => Promise<T | null>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn().catch(() => null);
    if (v !== null) return v;
    await Bun.sleep(1000);
  }
  throw new Error(`gate timeout waiting for: ${what}`);
}

function fail(msg: string): never {
  throw new Error(`GATE ASSERTION FAILED: ${msg}`);
}

let runId = "";
try {
  spawn(["bun", "apps/api/src/index.ts"]);
  await until(
    "api /health",
    async () => ((await fetch(`${BASE}/health`).catch(() => null))?.ok ? true : null),
    30_000,
  );
  for (const id of ["gate3-wA", "gate3-wB"]) {
    spawn(["bun", "apps/worker/src/main.ts"], { WORKER_ID: id });
  }

  // 1. Planner-driven run: real question, official-docs seed URLs.
  const res = await fetch(`${BASE}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "phase-3 gate",
      userRequest:
        "Does PostgreSQL support transactional DDL, and what are the practical limits? " +
        "Primary sources (content pages, not chapter TOCs): " +
        "https://wiki.postgresql.org/wiki/Transactional_DDL_in_PostgreSQL:_A_Competitive_Analysis " +
        "and https://www.postgresql.org/docs/current/sql-createtable.html",
    }),
  });
  if (res.status !== 201) fail(`POST /runs → ${res.status}`);
  runId = ((await res.json()) as { id: string }).id;
  console.log(`  ✓ run ${runId} created (planner-driven)`);

  // 2. Stage-1 delta applied: research tasks exist with concrete inputs.
  await until(
    "stage-1 research tasks",
    async () => {
      const rows = await sql`SELECT count(*)::int AS n FROM research_tasks
                             WHERE run_id = ${runId} AND type = 'research'`;
      return (rows[0]?.n as number) > 0 ? true : null;
    },
    240_000,
  );
  console.log("  ✓ stage-1 discovery tasks created");

  // 3. The full walk: run COMPLETED (discovery → extract → canonicalize →
  //    stage 2 → deep wave → extract …).
  await until(
    "run terminal state",
    async () => {
      const rows = await sql`SELECT status FROM research_runs WHERE id = ${runId}`;
      const s = rows[0]?.status as string;
      if (s === "FAILED" || s === "CANCELLED") fail(`run ended ${s}`);
      return s === "COMPLETED" ? true : null;
    },
    20 * 60_000,
  );
  console.log("  ✓ run COMPLETED");

  // 4. Staged planning happened: ≥2 plan stages, and EVERY task input is
  //    concrete (no placeholder text; research tasks name their question).
  const stages = await sql`SELECT stage FROM plan_stages WHERE run_id = ${runId} ORDER BY stage`;
  if (stages.length < 2) fail(`expected ≥2 plan stages, got ${stages.length}`);
  const tasks =
    await sql`SELECT id, type, title, input FROM research_tasks WHERE run_id = ${runId}`;
  for (const t of tasks) {
    const rendered = JSON.stringify(t.input);
    if (PLACEHOLDER.test(rendered) || PLACEHOLDER.test(String(t.title))) {
      fail(`task ${t.id} input/title contains placeholder text: ${rendered.slice(0, 120)}`);
    }
    if (t.type === "research") {
      const q = (t.input as { researchQuestion?: unknown }).researchQuestion;
      if (typeof q !== "string" || q.length < 8) fail(`research task ${t.id} has no question`);
    }
  }
  console.log(
    `  ✓ ${stages.length} plan stages; all ${tasks.length} task inputs concrete (ADR-011)`,
  );

  // 5. Two-pass research left evidence + deduplicated live claims.
  const ev = await sql`SELECT count(*)::int AS n FROM live_evidence WHERE run_id = ${runId}`;
  if ((ev[0]?.n as number) < 1) fail("no live evidence");
  const dup = await sql`
    SELECT subject_key, predicate_key, count(*)::int AS n
    FROM live_canonical_claims WHERE run_id = ${runId}
    GROUP BY subject_key, predicate_key HAVING count(*) > 1`;
  if (dup.length > 0) fail(`duplicate live claims: ${JSON.stringify(dup[0])}`);
  const claims =
    await sql`SELECT count(*)::int AS n FROM live_canonical_claims WHERE run_id = ${runId}`;
  if ((claims[0]?.n as number) < 1) fail("no live canonical claims");
  console.log(`  ✓ ${claims[0]?.n} live claims, ${ev[0]?.n} live evidence, zero duplicates`);

  // 6. Console read surface serves the phase's capabilities.
  const claimsApi = (await (await fetch(`${BASE}/runs/${runId}/claims`)).json()) as Array<{
    evidence: unknown[];
  }>;
  if (claimsApi.length < 1) fail("GET /runs/:id/claims is empty");
  const beats = await sql`
    SELECT DISTINCT type FROM events WHERE run_id = ${runId}
    AND type IN ('TASK_PLANNED','EXTRACT_TASK_CREATED','CANONICALIZATION_COMPLETED',
                 'PLAN_STAGE_ENQUEUED','PLANNER_TIER_DOWNGRADED')`;
  const found = new Set(beats.map((b) => b.type as string));
  for (const beat of [
    "TASK_PLANNED",
    "EXTRACT_TASK_CREATED",
    "CANONICALIZATION_COMPLETED",
    "PLAN_STAGE_ENQUEUED",
  ]) {
    if (!found.has(beat)) fail(`event log missing beat ${beat}`);
  }
  console.log(`  ✓ claims API + event beats (${[...found].join(", ")})`);

  console.log("✓ Phase 3 gate passed");
} finally {
  for (const c of children) c.kill();
  if (runId && process.env.GATE_KEEP_RUN !== "1") {
    await sql`DELETE FROM research_runs WHERE id = ${runId}`;
  }
  await close();
}
