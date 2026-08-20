// Phase 5 gate (implementation-plan §6, phase-5-plan D8). Two legs:
//
//   B — THE VALIDATOR (deterministic, no models): a doctored draft — an
//       uncited sentence and a chip pointing at a ghost claim — seeded as a
//       SUCCEEDED synthesize attempt. The live scheduler must REJECT it with
//       named checks (ADR-020), never complete the run.
//   A — THE PROVENANCE WALK (live): an end-to-end run produces a report; a
//       randomly sampled chip-bearing sentence is walked
//       sentence → chip → claim → live evidence → source → attempt
//       using API CALLS ONLY. The Uncertainties promise and the report
//       artifact are asserted along the way.
//
// Usage: bun run gate:p5   (leg A spends a few cents — frontier calls)
import { createDb, seedAttempt, seedRun, seedTask } from "@lab/db";
import { newId } from "@lab/schemas";

const API_PORT = 8794;
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

let children: Bun.Subprocess[] = [];
function startStack(): void {
  children.push(
    Bun.spawn(["bun", "apps/api/src/index.ts"], {
      env: baseEnv,
      stdout: "ignore",
      stderr: "inherit",
    }),
  );
  for (const id of ["gate5-wA", "gate5-wB"]) {
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

async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) fail(`GET ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

const runIds: string[] = [];
try {
  startStack();
  await until(
    "api /health",
    async () => ((await fetch(`${BASE}/health`).catch(() => null))?.ok ? true : null),
    30_000,
  );

  // ---------------- Leg B: the doctored draft is rejected ----------------
  console.log("— Leg B: validator rejects a doctored uncited draft (deterministic)");
  const runB = newId();
  const taskB = newId();
  const attemptB = newId();
  runIds.push(runB);
  await seedRun(db, runB, "phase-5 gate leg B (doctored draft)");
  await sql`UPDATE research_runs SET status = 'SYNTHESIZING' WHERE id = ${runB}`;
  await seedTask(db, {
    id: taskB,
    runId: runB,
    status: "EVALUATING",
    type: "synthesize",
    title: "Synthesize report",
  });
  await seedAttempt(db, {
    id: attemptB,
    taskId: taskB,
    runId: runB,
    status: "SUCCEEDED",
    output: {
      title: "Doctored",
      reportMarkdown: "This sentence smuggles in an uncited fact.\n\nThis cites a ghost. [c1]",
      citationMap: { c1: [newId()] }, // no such live claim
    },
  });
  await until(
    "leg B: doctored attempt REJECTED by the scheduler",
    async () => {
      const rows = await sql`SELECT status FROM attempts WHERE id = ${attemptB}`;
      const s = String(rows[0]?.status);
      if (s === "ACCEPTED") fail("leg B: validator ACCEPTED a doctored uncited draft");
      return s === "REJECTED" ? true : null;
    },
    60_000,
  );
  if ((await sql`SELECT status FROM research_runs WHERE id = ${runB}`)[0]?.status === "COMPLETED") {
    fail("leg B: run completed on a doctored draft");
  }
  const checksB = (
    await sql`SELECT evaluator_name FROM evaluations WHERE run_id = ${runB} AND decision = 'REJECT'`
  ).map((r) => String(r.evaluator_name));
  for (const check of ["check:uncited_sentences", "check:chips_cite_live_claims"]) {
    if (!checksB.includes(check)) fail(`leg B: missing rejection ${check} (got ${checksB})`);
  }
  console.log(`  ✓ rejected with named checks: ${checksB.join(", ")}`);

  // ---------------- Leg A: the provenance walk ----------------
  console.log("— Leg A: end-to-end run → report → API-only provenance walk");
  const resA = await fetch(`${BASE}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "phase-5 gate leg A",
      userRequest:
        "Does PostgreSQL support transactional DDL? A concise answer from the primary " +
        "source below is fully sufficient — plan a single research task and do not " +
        "survey additional publishers. Primary source (content page, not a TOC): " +
        "https://wiki.postgresql.org/wiki/Transactional_DDL_in_PostgreSQL:_A_Competitive_Analysis",
    }),
  });
  if (resA.status !== 201) fail(`POST /runs → ${resA.status}`);
  const runA = ((await resA.json()) as { id: string }).id;
  runIds.push(runA);

  await until(
    "leg A: run COMPLETED (through synthesis)",
    async () => {
      const rows = await sql`SELECT status FROM research_runs WHERE id = ${runA}`;
      const s = String(rows[0]?.status);
      if (s === "FAILED" || s === "CANCELLED") fail(`leg A run ended ${s}`);
      if (s === "WAITING_HUMAN") fail("leg A: parked at a checkpoint instead of completing");
      return s === "COMPLETED" ? true : null;
    },
    45 * 60_000,
  );
  console.log("  ✓ run COMPLETED");

  // From here on: API CALLS ONLY (the gate's whole point).
  interface Report {
    attemptId: string;
    title: string | null;
    markdown: string | null;
    citationMap: Record<string, string[]>;
    artifactId: string | null;
  }
  const report = await api<Report>(`/runs/${runA}/report`);
  if (!report.markdown) fail("leg A: report has no markdown");
  if (!report.artifactId) fail("leg A: report artifact was not persisted");
  if (Object.keys(report.citationMap).length === 0) fail("leg A: empty citationMap");
  console.log(
    `  ✓ report "${report.title}" · ${Object.keys(report.citationMap).length} chips · artifact ${report.artifactId}`,
  );

  // Sample a random chip-bearing sentence.
  const sentences = report.markdown
    .split("\n")
    .flatMap((l) => l.split(/(?<=[.!?])\s+/))
    .filter((s) => /\[c\d+\]/.test(s));
  if (sentences.length === 0) fail("leg A: no chip-bearing sentences in the report");
  const sentence = sentences[Math.floor(Math.random() * sentences.length)] as string;
  const chip = (/\[(c\d+)\]/.exec(sentence) as RegExpExecArray)[1] as string;
  console.log(`  · sampled: "${sentence.trim().slice(0, 100)}" → chip ${chip}`);

  // chip → claims (citationMap must agree with the citations endpoint).
  const claimIds = report.citationMap[chip];
  if (!claimIds || claimIds.length === 0) fail(`leg A: chip ${chip} missing from citationMap`);
  interface Citation {
    chip: string;
    claims: Array<{
      id: string;
      statement: string | null;
      status: string | null;
      evidence: Array<{ attemptId: string; sourceUrl: string | null; excerpt: string }>;
    }>;
  }
  const citations = await api<Citation[]>(`/runs/${runA}/report/citations`);
  const resolved = citations.find((c) => c.chip === chip);
  if (!resolved) fail(`leg A: citations endpoint has no entry for ${chip}`);
  const claim = resolved.claims.find((cl) => cl.statement !== null);
  if (!claim) fail(`leg A: chip ${chip} resolves to no live claim`);
  console.log(`  ✓ chip → live claim (${claim.status}): "${claim.statement?.slice(0, 80)}"`);

  // claim → live evidence → source.
  const evidence = claim.evidence[0];
  if (!evidence) fail("leg A: cited claim has no live evidence");
  if (!evidence.sourceUrl) fail("leg A: evidence has no source URL");
  console.log(`  ✓ claim → evidence → source ${evidence.sourceUrl.slice(0, 60)}`);

  // evidence → attempt: the attempt exists in the run and its trace assembles.
  const attempts = await api<Array<{ id: string }>>(`/runs/${runA}/attempts`);
  if (!attempts.some((a) => a.id === evidence.attemptId)) {
    fail(`leg A: evidence attempt ${evidence.attemptId} not among the run's attempts`);
  }
  const trace = await api<{ attempt: { id: string }; blocks: Array<{ kind: string }> }>(
    `/runs/${runA}/attempts/${evidence.attemptId}/trace`,
  );
  if (trace.blocks[0]?.kind !== "context_in") fail("leg A: trace does not open with context_in");
  console.log(
    `  ✓ evidence → attempt ${evidence.attemptId} (trace: ${trace.blocks.length} blocks)`,
  );

  // The Uncertainties promise: every acceptedUncertainty appears as a section.
  const verdicts = await api<Array<{ decision: string; metadata: Record<string, unknown> }>>(
    `/runs/${runA}/verdicts`,
  );
  const accepted = [...verdicts].reverse().find((v) => v.decision === "ACCEPT") ?? verdicts.at(-1);
  const uncertainties = Array.isArray(accepted?.metadata.acceptedUncertainties)
    ? (accepted.metadata.acceptedUncertainties as string[])
    : [];
  if (uncertainties.length > 0 && !/^#{1,6}\s*uncertaint/im.test(report.markdown)) {
    fail("leg A: verdict accepted uncertainties but the report has no Uncertainties section");
  }
  console.log(`  ✓ uncertainties promise honored (${uncertainties.length} accepted)`);

  // Transcript serves the staged reading mode.
  const transcript = await api<{ traces: Array<{ attempt: { id: string } }> }>(
    `/runs/${runA}/transcript`,
  );
  if (transcript.traces.length === 0) fail("leg A: transcript is empty");
  console.log(`  ✓ transcript: ${transcript.traces.length} traces in stage order`);

  console.log("✓ Phase 5 gate passed — every sentence traces to its source");
} finally {
  stopStack();
  if (process.env.GATE_KEEP_RUN !== "1") {
    for (const id of runIds) await sql`DELETE FROM research_runs WHERE id = ${id}`;
  }
  await close();
}
