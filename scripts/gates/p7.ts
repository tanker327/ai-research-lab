// Phase 7 gate, API leg (phase-7-plan). A review-flagged run must:
//   1. park at plan_review after stage-1 planning (nothing claimed while held);
//   2. accept live edits — one task's question rewritten, one task removed,
//      one task added, the analyst re-routed to the frontier tier;
//   3. after approve, complete end-to-end with the edits REAL:
//      · the edited question is what the researcher actually received
//        (attempt input, R12 verbatim);
//      · the removed task never ran (CANCELLED, zero attempts);
//      · the added task ran;
//      · the analyst's model calls carry the chosen tier.
// The console leg (same flow interactively) closes the phase with the user.
//
// Usage: bun run gate:p7   (live — spends a few cents)
import { createDb } from "@lab/db";

const API_PORT = 8796;
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
  for (const id of ["gate7-wA", "gate7-wB"]) {
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

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!res.ok) fail(`${init?.method ?? "GET"} ${path} → ${res.status} ${await res.text()}`);
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

  console.log("— review-flagged run: plan → pause");
  const { id: runId } = await api<{ id: string }>("/runs", {
    method: "POST",
    body: JSON.stringify({
      title: "phase-7 gate",
      userRequest:
        "Does PostgreSQL support transactional DDL? A concise answer from the primary " +
        "source below is fully sufficient — plan ONE research task and do not survey " +
        "additional publishers. Primary source (content page, not a TOC): " +
        "https://wiki.postgresql.org/wiki/Transactional_DDL_in_PostgreSQL:_A_Competitive_Analysis",
      reviewPlan: true,
    }),
  });
  runIds.push(runId);

  const checkpoint = await until(
    "run parked at plan_review",
    async () => {
      const cps = await api<Array<{ id: string; reason: string; status: string }>>(
        `/runs/${runId}/checkpoints`,
      );
      return cps.find((c) => c.reason === "plan_review" && c.status === "pending") ?? null;
    },
    10 * 60_000,
  );
  const runRow = await api<{ status: string }>(`/runs/${runId}`);
  if (runRow.status !== "WAITING_HUMAN") fail(`parked run is ${runRow.status}`);
  console.log("  ✓ parked at plan_review (WAITING_HUMAN)");

  interface Task {
    id: string;
    type: string;
    status: string;
    title: string;
    input: Record<string, unknown>;
  }
  const held = (await api<Task[]>(`/runs/${runId}/tasks`)).filter(
    (t) => t.type === "research" && t.status === "CREATED",
  );
  if (held.length === 0) fail("no held research tasks to edit");
  // Hold check: nothing may be claimed while parked.
  await Bun.sleep(3000);
  const claimed = await sql`
    SELECT count(*)::int AS n FROM research_tasks
    WHERE run_id = ${runId} AND status NOT IN ('CREATED','DONE','CANCELLED') AND type <> 'plan'`;
  if (((claimed[0]?.n as number) ?? 0) > 0) fail("the hold leaked — a held task was promoted");
  console.log(`  ✓ ${held.length} research task(s) held CREATED while parked`);

  console.log("— live edits through the API");
  const EDITED_QUESTION =
    "GATE-EDITED QUESTION: summarize what the linked PostgreSQL wiki page says about transactional DDL in one pass?";
  const editTarget = held[0] as Task;
  await api(`/runs/${runId}/tasks/${editTarget.id}`, {
    method: "PATCH",
    body: JSON.stringify({ researchQuestion: EDITED_QUESTION, priority: 90 }),
  });

  const { id: addedId } = await api<{ id: string }>(`/runs/${runId}/tasks`, {
    method: "POST",
    body: JSON.stringify({
      title: "gate-added task",
      researchQuestion:
        "From the SAME PostgreSQL wiki page already fetched, which commands are called out as non-transactional?",
      priority: 40,
    }),
  });

  // Remove: prefer a second planner task; else add-then-remove a sacrifice.
  let removedId = (held[1] as Task | undefined)?.id;
  if (!removedId) {
    const sacrifice = await api<{ id: string }>(`/runs/${runId}/tasks`, {
      method: "POST",
      body: JSON.stringify({
        title: "gate-removed task",
        researchQuestion: "a task created only so the gate can remove it, correct?",
      }),
    });
    removedId = sacrifice.id;
  }
  await api(`/runs/${runId}/tasks/${removedId}`, { method: "DELETE" });

  await api(`/runs/${runId}/routing`, {
    method: "PATCH",
    body: JSON.stringify({ roleTiers: { analyst: "frontier" } }),
  });
  const audits = await sql`
    SELECT count(*)::int AS n FROM decision_records
    WHERE run_id = ${runId} AND type = 'human_plan_edit'`;
  if (((audits[0]?.n as number) ?? 0) < 3) fail("plan edits left fewer than 3 audit records");
  console.log("  ✓ edited · added · removed · analyst→frontier (all audited)");

  console.log("— approve → run completes with the edits real");
  await api(`/runs/${runId}/checkpoints/${checkpoint.id}/resolve`, {
    method: "POST",
    body: JSON.stringify({ action: "approve", note: "gate approval" }),
  });
  await until(
    "run COMPLETED",
    async () => {
      const r = await api<{ status: string }>(`/runs/${runId}`);
      if (["FAILED", "CANCELLED"].includes(r.status)) fail(`run ended ${r.status}`);
      if (r.status === "WAITING_HUMAN") fail("run re-parked after approval");
      return r.status === "COMPLETED" ? true : null;
    },
    45 * 60_000,
  );
  console.log("  ✓ run COMPLETED");

  // Edited question is what the researcher actually received (R12).
  const receivedQuestion = await sql`
    SELECT a.input->>'question' AS q FROM attempts a
    WHERE a.task_id = ${editTarget.id} ORDER BY a.attempt_number DESC LIMIT 1`;
  if (!String(receivedQuestion[0]?.q ?? "").includes("GATE-EDITED QUESTION")) {
    fail(`researcher received "${receivedQuestion[0]?.q}" — not the edited question`);
  }
  console.log("  ✓ edited question is the researcher's verbatim input");

  const removed = await sql`
    SELECT t.status, count(a.id)::int AS attempts FROM research_tasks t
    LEFT JOIN attempts a ON a.task_id = t.id
    WHERE t.id = ${removedId} GROUP BY t.status`;
  if (removed[0]?.status !== "CANCELLED" || (removed[0]?.attempts as number) !== 0) {
    fail(`removed task: ${JSON.stringify(removed[0])} — it must be CANCELLED with 0 attempts`);
  }
  const added = await sql`
    SELECT count(*)::int AS n FROM attempts WHERE task_id = ${addedId}`;
  if (((added[0]?.n as number) ?? 0) < 1) fail("added task never ran");
  console.log("  ✓ removed task never ran; added task ran");

  const analystCalls = await sql`
    SELECT DISTINCT mc.model_tier FROM model_calls mc
    JOIN attempts a ON a.id = mc.attempt_id
    JOIN research_tasks t ON t.id = a.task_id
    WHERE t.run_id = ${runId} AND t.type = 'analyze' AND mc.purpose = 'agent'`;
  const tiers = analystCalls.map((r) => String(r.model_tier));
  if (!tiers.includes("frontier")) {
    fail(`analyst model calls used tiers [${tiers}] — the frontier re-route never applied`);
  }
  console.log(`  ✓ analyst ran on the chosen tier (model_calls: ${tiers.join(", ")})`);

  console.log("✓ Phase 7 gate (API leg) passed — remaining: the console review leg with the user");
} finally {
  stopStack();
  if (process.env.GATE_KEEP_RUN !== "1") {
    for (const id of runIds) await sql`DELETE FROM research_runs WHERE id = ${id}`;
  }
  await close();
}
