# AI Research Lab — Implementation Plan

**Version:** 1.0
**Date:** 2026-08-19
**Status:** Ready to execute
**Companion to:** `ai-research-lab-system-design-v0.2.1.md`
**Target:** V0.05 minimal proven loop (design doc §3.1, §20)

---

# 1. Purpose

This document turns the v0.2.1 system design into an executable build plan: the locked stack, the repo layout, the core interfaces in real TypeScript, phase-by-phase tickets with acceptance tests, the golden-task regression suite, and the failure-injection matrix.

The finish line is the design doc's proof-point milestone:

> The Evaluator discovers a missing piece of evidence that was not in the original plan, the system autonomously creates a new research task, executes it, updates its analysis, and the Evaluator later accepts the improved result.

---

# 2. Stack Decisions (locked)

Each decision records what was rejected, so we don't relitigate mid-build.

| Layer | Choice | Rejected | Why |
|---|---|---|---|
| Orchestration | **Build it** (`packages/core`, ~1.5k LOC deterministic TS) | LangGraph, Mastra/CrewAI/AutoGen, Inngest/Trigger.dev, Temporal | Frameworks own state/retry semantics that conflict with Run/Task/Attempt/liveness as queryable Postgres rows (ADR-008). Temporal deferred, not rejected — see §10. |
| Runtime | **Bun** everywhere | Node | Existing stack (ai-hub, Juicer). Escape hatch: worker app may fall back to Node if drivers misbehave under sustained load; monorepo isolates the change. |
| API | **Hono** | Fastify, Express | Existing stack; `streamSSE` covers the live event feed natively. |
| DB | **PostgreSQL 16** + **Drizzle** + drizzle-kit | Prisma, raw pg only | Drizzle for schema/migrations/CRUD; **hot control-plane queries (claim, supersede, readiness sweep) are raw `sql\`\`` templates** — never forced through the ORM. |
| Model calls | **Vercel AI SDK** as a library inside `packages/model`, OpenAI-compatible provider → **ai-hub** | Hand-rolled fetch, LangChain, provider SDKs directly | `generateObject` + Zod = structured outputs and tool loops for free. ai-hub keeps routing, cost tracking, and async-job handling. SDK stays *below* the `ModelClient` interface — it is not the architecture. |
| Extractor decoding | **vLLM guided decoding** via `response_format: json_schema` through ai-hub | Retry-on-parse-failure | ADR-012: schema failure becomes near-impossible instead of a retry category. |
| Queue | **None** — Postgres `FOR UPDATE SKIP LOCKED` + 500ms poll | BullMQ, pg-boss | Scheduler *is* the dependency resolver (custom logic no queue provides). Trigger to revisit: measured poll pressure or >4 workers. pg-boss first (no Redis), BullMQ if Redis already justified. |
| Validation | **Zod v4** | TypeBox, Valibot | Agent contracts + AI SDK integration + one schema source (`packages/schemas`). |
| IDs | **UUIDv7** | UUIDv4, cuid | Time-ordered — events/attempts index and sort naturally. |
| Logging | **pino** | console, winston | Structured; child loggers per run/task/attempt. |
| Tests | **Vitest** + real Postgres (compose; testcontainers optional) | mocked DB | The control plane's correctness *is* SQL semantics — mock DB tests would test nothing. |
| Web | **Vite + React + TanStack Query** | Next.js | Console is a pure projection of read APIs (ADR-017); no SSR need. Mockup's CSS tokens port directly. |
| Deploy | docker compose on Proxmox VM; vLLM on Blackwell box (OpenAI-compatible); k3s later | k8s now | App is stateless-except-Postgres by design; the k3s migration should be boring. |

---

# 3. Repository Layout

```text
ai-research-lab/
├─ package.json                  # bun workspaces
├─ bunfig.toml
├─ tsconfig.base.json
├─ .env.example
├─ infra/
│  ├─ docker-compose.yml         # postgres · api · worker×2 · web
│  └─ init/                      # db bootstrap
├─ docs/
│  ├─ system-design-v0.2.1.md
│  ├─ implementation-plan.md     # this file
│  └─ adr/                       # ADR-001…020 as individual files
├─ apps/
│  ├─ api/
│  │  └─ src/
│  │     ├─ index.ts             # Hono app
│  │     ├─ routes/              # runs · tasks · claims · trace · transcript · report
│  │     ├─ sse.ts               # GET /runs/:id/events/stream
│  │     └─ scheduler.ts         # readiness sweep + stale-claim sweep + run coordinator (V0.05: lives in api)
│  ├─ worker/
│  │  └─ src/
│  │     ├─ main.ts              # claim loop
│  │     ├─ dispatch.ts          # task → agent resolution → context → run → persist
│  │     └─ shutdown.ts          # SIGTERM: finish current attempt, release claim
│  └─ web/
│     └─ src/                    # console; mockup research-lab-console.html is the spec (§24.6)
├─ packages/
│  ├─ core/                      # ★ CONTROL PLANE — deterministic, zero LLM imports
│  │  └─ src/
│  │     ├─ state/               # run + task + attempt state machines (pure functions)
│  │     ├─ scheduler/           # readiness, stale-claim release, phase transitions
│  │     ├─ claim.ts             # atomic claim (raw SQL)
│  │     ├─ liveness.ts          # accept + supersede transaction (raw SQL)
│  │     ├─ retry.ts             # infra backoff + intelligence ladder
│  │     ├─ budget.ts            # caps + cycle guard
│  │     ├─ checks/              # deterministic pre-checks (min evidence, vendor rule, citations)
│  │     └─ events.ts            # event emitter → db + SSE fanout
│  ├─ agents/
│  │  └─ src/{planner,researcher,extractor,analyst,evaluator,synthesizer}/v1/
│  │     ├─ schema.ts            # re-exports from packages/schemas
│  │     ├─ prompt.ts
│  │     └─ agent.ts
│  ├─ model/                     # ModelClient impl (AI SDK → ai-hub) + router policy table
│  ├─ tools/                     # search · fetch(+snapshot artifact) · registry + allowlists
│  ├─ context/                   # Context Builder (own package on purpose — R8/§12)
│  ├─ evidence/                  # canonicalization pipeline · coverage summary computation
│  ├─ db/                        # drizzle schema · migrations · repositories · raw queries
│  └─ schemas/                   # ★ single Zod source: all agent I/O, trace blocks, API DTOs
└─ scripts/                      # seed, golden-task runner, failure injection
```

**Two rules enforced from commit one (CI-checked via dependency-cruiser or a simple import-lint script):**

1. `packages/core` imports nothing from `agents/`, `model/`, or `tools/`. This is what makes Phase 1 a pure, fast, LLM-free test target.
2. All agent contracts live only in `packages/schemas`. API, worker, and web type against one source; drift is a compile error.

---

# 4. Environment & Configuration

```text
DATABASE_URL=postgres://lab:lab@localhost:5432/research_lab
ARTIFACT_ROOT=./data/artifacts

AIHUB_BASE_URL=http://192.168.10.114/v1        # OpenAI-compatible (deployed hub; amended P2.1)
AIHUB_SERVICE_NAME=research-lab                 # hub auth = x-service-name header, not a bearer key

# Tiers bind to hub ALIASES (phase-2-plan D1) — the hub owns the concrete model behind each.
MODEL_FRONTIER=best                             # openai/gpt-5.6-sol (needs valid key on hub)
MODEL_STRONG_LOCAL=default                      # local model; json_schema + tools verified
MODEL_FAST_LOCAL=cheapest                       # deepseek; json_object mode (D2)

WORKER_CONCURRENCY=2
GPU_CONCURRENCY_STRONG_LOCAL=2                  # gateway-side cap
TASK_CLAIM_TIMEOUT_S=900
POLL_INTERVAL_MS=500
DEFAULT_MAX_ATTEMPTS=3
DEFAULT_MAX_EVAL_CYCLES=3
```

Typed config module (`packages/core/src/config.ts`) validates all of this with Zod at startup; a missing var is a crash at boot, never a runtime surprise.

---

# 5. Core Interfaces — Real TypeScript

The load-bearing code, written out so a coding agent implements *this*, not an interpretation.

## 5.1 State machines (pure functions)

```ts
// packages/core/src/state/task.ts
export type TaskStatus =
  | "CREATED" | "READY" | "RUNNING" | "EVALUATING"
  | "DONE" | "FAILED" | "BLOCKED" | "WAITING_HUMAN" | "CANCELLED";

const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  CREATED:      ["READY", "BLOCKED", "CANCELLED"],
  READY:        ["RUNNING", "CANCELLED"],
  RUNNING:      ["EVALUATING", "READY", "CANCELLED"],   // stale release goes via EVALUATING since P1.3 (rule 10); READY retained but unused
  EVALUATING:   ["DONE", "READY", "BLOCKED", "WAITING_HUMAN", "FAILED", "CANCELLED"],
  WAITING_HUMAN:["READY", "CANCELLED"],
  BLOCKED:      ["READY", "CANCELLED"],                 // unblocked by replan
  DONE: [], FAILED: [], CANCELLED: [],
};

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!TRANSITIONS[from].includes(to))
    throw new InvalidTransitionError({ from, to });     // typed error, never silent
}
```

Every repository status update calls `assertTransition` inside the same transaction. An illegal transition is a bug surfaced loudly, not a row quietly corrupted.

## 5.2 Atomic claim (raw SQL)

```ts
// packages/core/src/claim.ts
export async function claimNextReadyTask(db: Db, workerId: string) {
  return db.transaction(async (tx) => {
    const [task] = await tx.execute(sql`
      SELECT * FROM research_tasks
      WHERE status = 'READY'
      ORDER BY priority DESC, created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1`);
    if (!task) return null;
    await tx.execute(sql`
      UPDATE research_tasks
      SET status = 'RUNNING', claimed_by = ${workerId},
          claimed_at = now(), updated_at = now()
      WHERE id = ${task.id}`);
    const attempt = await createAttempt(tx, task);       // attempt_number = attempt_count + 1
    await emitEvent(tx, { type: "TASK_CLAIMED", kind: "info", taskId: task.id,
                          attemptId: attempt.id, actor: workerId });
    return { task, attempt };
  });
}
```

## 5.3 Accept + supersede (the liveness transaction, ADR-014)

```ts
// packages/core/src/liveness.ts
export async function acceptAttempt(db: Db, attemptId: string) {
  return db.transaction(async (tx) => {
    const attempt = await getAttemptForUpdate(tx, attemptId);
    assertAttempt(attempt.status === "SUCCEEDED");

    // 1. Accept this attempt — its side effects become live.
    await tx.execute(sql`
      UPDATE attempts SET status = 'ACCEPTED', completed_at = now()
      WHERE id = ${attemptId}`);

    // 2. Supersede all prior non-terminal attempts of the task — their rows go dark.
    await tx.execute(sql`
      UPDATE attempts SET status = 'SUPERSEDED'
      WHERE task_id = ${attempt.taskId} AND id != ${attemptId}
        AND status IN ('SUCCEEDED','FAILED','REJECTED')`);

    // 3. Task done; canonicalization re-runs over the changed live set.
    await updateTaskStatus(tx, attempt.taskId, "DONE");
    await enqueueCanonicalization(tx, attempt.runId);
    await emitEvent(tx, { type: "ATTEMPT_ACCEPTED", kind: "accept",
                          taskId: attempt.taskId, attemptId });
  });
}
```

Downstream visibility is a view, not application logic:

```sql
CREATE VIEW live_evidence AS
  SELECT e.* FROM evidence e JOIN attempts a ON a.id = e.attempt_id
  WHERE a.status = 'ACCEPTED';
-- identical live_raw_claims view; canonical_claims are derived from live_raw_claims only.
```

## 5.4 Retry ladder

```ts
// packages/core/src/retry.ts
export type RetryVerdict =
  | { kind: "infra_retry"; delayMs: number }
  | { kind: "intelligence_retry"; strategy?: ResearchStrategy; tier?: ModelTier }
  | { kind: "task_failed" };

const INFRA_BACKOFF = [5_000, 30_000, 120_000];
const STRATEGY_FALLBACK: Partial<Record<ResearchStrategy, ResearchStrategy>> = {
  comparative: "primary_sources",
  broad_discovery: "community_evidence",
  benchmark_focused: "independent_validation",
};

export function decideRetry(a: AttemptRow, err: CategorizedError | null,
                            quality: QualityVerdict | null): RetryVerdict {
  if (err?.category === "TRANSIENT_INFRA" || err?.category === "TOOL_FAILURE") {
    const n = a.infraRetryCount;
    return n < INFRA_BACKOFF.length
      ? { kind: "infra_retry", delayMs: INFRA_BACKOFF[n] }
      : { kind: "task_failed" };
  }
  if (err?.category === "SCHEMA_FAILURE" && a.taskType === "extract")
    return { kind: "intelligence_retry" };               // re-extract only — never re-research (P8)

  if (quality?.rejected) {                               // deterministic check or Evaluator
    if (a.attemptNumber === 1)
      return { kind: "intelligence_retry",
               strategy: STRATEGY_FALLBACK[a.strategy] ?? a.strategy };
    if (a.attemptNumber === 2)
      return { kind: "intelligence_retry", tier: "frontier" };
    return { kind: "task_failed" };                      // Evaluator decides what failure means
  }
  return { kind: "task_failed" };
}
```

Every verdict writes a `DecisionRecord` with human-readable rationale — the trace UI's amber/red control blocks render these verbatim (§24.2).

## 5.5 Agent contract + dispatch

```ts
// packages/schemas/src/agent.ts
export interface AgentContext {
  runId: string; taskId: string; attemptId: string;
  model: ModelClient;                    // pre-routed for this attempt
  tools: ScopedToolRegistry;             // allowlist already applied
  artifacts: ArtifactStore;
  signal: AbortSignal;
  log: Logger;
}
export interface Agent<I, O> {
  readonly name: string; readonly version: string;
  readonly inputSchema: z.ZodType<I>; readonly outputSchema: z.ZodType<O>;
  run(input: I, ctx: AgentContext): Promise<O>;
}
```

```ts
// apps/worker/src/dispatch.ts — the whole worker, essentially
const agent  = registry.resolve(task.agentRole, task.agentVersion);
const input  = agent.inputSchema.parse(await contextBuilder.build(task));  // R12: persisted verbatim
await persistAttemptInput(attempt.id, input);
const model  = router.resolve(task, attempt);                              // policy table
const output = await agent.run(input, makeContext(task, attempt, model));
const valid  = agent.outputSchema.safeParse(output);
if (!valid.success) throw new CategorizedError("SCHEMA_FAILURE", valid.error);
await persistAttemptOutput(attempt.id, valid.data);
await core.markEvaluating(task.id);      // deterministic checks + accept/reject happen scheduler-side
```

## 5.6 ModelClient (AI SDK → ai-hub)

```ts
// packages/model/src/client.ts
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateObject, generateText } from "ai";

const aihub = createOpenAICompatible({ baseURL: env.AIHUB_BASE_URL, apiKey: env.AIHUB_API_KEY });

export const modelClient: ModelClient = {
  async generateStructured({ model, schema, system, messages, providerOptions }) {
    const t0 = Date.now();
    const res = await generateObject({
      model: aihub(model), schema, system, messages,
      providerOptions,                    // vLLM guided decoding flags for fast_local flow through here
    });
    await recordModelCall({ model, usage: res.usage, latencyMs: Date.now() - t0,
                            reasoning: res.reasoning ?? null });   // R11: persisted as artifact if present
    return res.object;
  },
  // generateWithTools(...) — Researcher pass-1 loop: maxSteps, tool set from ScopedToolRegistry,
  //   every step's tool call persisted with seq (R13) + response snapshot artifact.
};
```

Router is a data table, not code:

```ts
// packages/model/src/policy.ts
export const ROUTING: RoutingRule[] = [
  { role: "planner",     tier: "frontier" },
  { role: "evaluator",   tier: "frontier" },
  { role: "synthesizer", tier: "frontier" },
  { role: "extractor",   tier: "fast_local", guided: true },
  { role: "researcher",  tier: "strong_local" },
  { role: "researcher",  attemptGte: 3, tier: "frontier" },        // ladder escalation
  { role: "analyst",     tier: "strong_local" },
];
```

---

# 6. Build Phases & Tickets

Phases match the design doc's roadmap (§19), broken into agent-sized tickets. Each phase ends with an acceptance test that gates the next. Estimated calendar assumes nights-and-weekends solo pace with coding-agent leverage; compress freely.

```mermaid
flowchart LR
    P0[P0 Foundation<br/>~2 evenings] --> P1[P1 Task Engine<br/>~1 week]
    P1 --> P2[P2 Model+Tools<br/>~3 evenings]
    P2 --> P3[P3 Plan·Research·Extract<br/>~1 week]
    P3 --> P4[P4 Analyst+Evaluator+Loop<br/>~1 week]
    P4 --> M{{MILESTONE<br/>autonomous gap-fill accepted}}
    M --> P5[P5 Synthesizer+Validator<br/>~3 evenings]
    P5 --> P6[P6 Console UI<br/>~1 week]
```

## Phase 0 — Foundation (~2 evenings)

| # | Ticket | Notes |
|---|---|---|
| 0.1 | Monorepo scaffold: bun workspaces, tsconfig, import-lint (core isolation rule) | |
| 0.2 | `infra/docker-compose.yml`: postgres16 + volumes | |
| 0.3 | `packages/db`: drizzle schema for all v0.2.1 tables + migration 0001 | schema from design §17/§24.7 |
| 0.4 | `packages/schemas`: TaskStatus/AttemptStatus/EventKind enums + error taxonomy | |
| 0.5 | Typed config + pino setup + uuidv7 helper | |

**Gate:** `bun run migrate && bun test` green; api/worker boot and connect.

## Phase 1 — Deterministic Task Engine (~1 week) · **no LLM anywhere**

| # | Ticket | Notes |
|---|---|---|
| 1.1 | Task + attempt state machines with `assertTransition` (§5.1) | pure fn + unit tests |
| 1.2 | Atomic claim (§5.2) + worker claim loop with fake handlers | |
| 1.3 | Readiness sweep (deps DONE → READY) + stale-claim release | scheduler.ts |
| 1.4 | Accept/supersede liveness transaction (§5.3) + `live_*` views | |
| 1.5 | Retry ladder (§5.4) + DecisionRecords | |
| 1.6 | Event emitter → db + in-process SSE fanout | |
| 1.7 | Run coordinator: phase transitions, cancellation, cycle guard, budget stubs | |
| 1.8 | API: create run, get run/tasks/events, cancel | |

**Gate (the Phase-1 acceptance test, scripted):** create run → seed 5 fake tasks with a dependency chain → 2 workers execute sleep-handlers → kill worker A mid-task (SIGKILL) → stale claim releases → retry succeeds → run COMPLETED → assert: no duplicate live side effects, event log tells the full story, all transitions legal.

## Phase 2 — Model Gateway + Tools (~3 evenings)

| # | Ticket | Notes |
|---|---|---|
| 2.1 | `packages/model`: ModelClient via AI SDK → ai-hub (§5.6) + usage/reasoning persistence | |
| 2.2 | Router policy table + gateway-side `GPU_CONCURRENCY_STRONG_LOCAL` semaphore | |
| 2.3 | `packages/tools`: web_search + web_fetch (snapshot → content-addressed artifact) + registry with per-role allowlists + `seq` logging | |
| 2.4 | Artifact store: local fs, sha256 content addressing | |

**Gate:** one test agent runs `generateStructured` against frontier AND strong_local through ai-hub; guided decoding verified against fast_local with a deliberately nasty schema; tool calls persist ordered with snapshots.

## Phase 3 — Planner · Researcher · Extractor (~1 week)

| # | Ticket | Notes |
|---|---|---|
| 3.1 | `packages/context`: forPlanner / forResearcher builders + token budgeting | R12: output persisted verbatim |
| 3.2 | Planner v1: clarify-stage prompt, PlannerOutput schema, PlanDelta interpretation in core | staged planning |
| 3.3 | Researcher v1: pass-1 tool loop → Research Note artifact + tool-layer sourcesVisited | |
| 3.4 | Extractor v1: guided decoding, auto-created `extract` task after research accept | |
| 3.5 | `packages/evidence`: canonicalization (normalize → trgm candidates → batch-confirm → upsert) | pg_trgm |
| 3.6 | Deterministic checks: min-evidence, non-vendor rule | core/checks |

**Gate (verifies R3):** submit a real question → stage-1 discovery runs → extraction → **stage-2 tasks exist in the DB with fully concrete inputs** (assert: no placeholder strings, every deep task names its subjects) → deep wave completes → canonical claims deduplicated (assert: no duplicate subject+predicate rows).

## Phase 4 — Analyst · Evaluator · Autonomous Loop (~1 week) ★

| # | Ticket | Notes |
|---|---|---|
| 4.1 | Coverage summary computation (deterministic) → persisted on evaluation | packages/evidence |
| 4.2 | Analyst v1: claim-bundle context (K=3 heuristic), findings-cite-claims schema check | |
| 4.3 | Evaluator v1: merged critic+judge prompt, decision schema | frontier |
| 4.4 | Core interprets decisions: RESEARCH_MORE → tasks from requiredActions (no Planner call); REPLAN → planner task; cycle guard enforced | |
| 4.5 | Intelligence-retry wiring end to end (deterministic reject → ladder → tier escalation) | |

**Gate — THE MILESTONE:** on a seeded golden task, the Evaluator identifies a genuine gap → core creates the follow-up task → it executes → analysis v2 → **ACCEPT on cycle 2**. Separately: force a never-satisfiable rubric and assert the cycle guard hard-stops at 3 with a WAITING_HUMAN checkpoint.

## Phase 5 — Synthesizer + Citation Validator (~3 evenings)

| # | Ticket | Notes |
|---|---|---|
| 5.1 | Synthesizer v1: approved-material-only context, citationMap output | web tools denied |
| 5.2 | Deterministic citation validator: uncited factual sentence ⇒ REJECT attempt (ADR-020) | |
| 5.3 | Read APIs: trace, transcript (paginated by stage), claims, coverage, citations | §24.5 |

**Gate:** end-to-end run produces a report where a randomly sampled factual sentence traces sentence → claim → live evidence → source → attempt via API calls only; validator demonstrably rejects a doctored uncited draft.

## Phase 6 — Console UI (~1 week)

> **Amended 2026-08-19 (user decision):** the console is no longer a last-minute
> phase — it is built **incrementally from Phase 2 onward**. Console v0 (shell,
> runs list, new-run, overview + phase rail, task board, kind-colored timeline
> with SSE live tail — all against real Phase-1 read APIs; evidence/report/
> transcript as labeled placeholders) shipped early in `apps/web`. From here,
> **every phase's definition of done includes wiring its new capabilities into
> the console** (P2: model/tool call panels · P3: evidence & claims browser,
> real Planner-driven new-run · P4: verdicts, decision blocks · P5: report +
> transcript). This section remains the target end state; its gate is unchanged.

Port the mockup (`research-lab-console.html`) view-for-view against real read APIs: runs list, new-research, overview (phase rail + metrics + latest verdict), staged-column task graph, inspector drawer with trace viewer, claims & evidence browser, kind-colored timeline with SSE live tail, report with citation-chip jumps, transcript reading mode. The mockup's CSS tokens and interactions are normative (ADR-019, §24.6).

**Gate:** watch a live run end-to-end in the console; open a superseded attempt's trace after an API restart (verifies ADR-017 + §24.9).

---

# 7. Golden Research Tasks (regression suite from Phase 4 on)

Stored under `scripts/golden/`, run on demand and before any prompt/agent-version bump. Each records: evaluator cycles, retries, frontier calls, wall-clock, $ spend, and a human pass/fail on the recommendation.

| ID | Task | What it exercises |
|---|---|---|
| G1 | "Compare Cloudflare R2 vs Backblaze B2 vs self-hosted Garage for homelab artifact storage" | staged planning, comparative research, clean accept (target: 1 cycle) |
| G2 | "What is the LiveCodeBench score of <model with known vendor/independent discrepancy>?" | vendor rule, contested claim, follow-up loop (target: 2 cycles, contest surfaced) |
| G3 | "Best ECC UDIMM kit currently compatible with ASUS W680-ACE at 96GB" | recency pressure, community evidence, spec-constraint checking |
| G4 | Deliberately ambiguous goal ("best storage") | clarify-stage inference vs human-question discipline |

Budget assertion on all four: ≤ $1.50 frontier spend, ≤ 45 min wall-clock, cycle guard never breached silently.

---

# 8. Failure-Injection Matrix (Phase 1 & 4 test fixtures)

| Injection | Expected behavior |
|---|---|
| SIGKILL worker mid-attempt | stale-claim sweep → READY; attempt FAILED(TRANSIENT_INFRA); retry; **no duplicate live rows** |
| ai-hub returns 429 ×2 then ok | backoff 5s/30s; infra retries don't consume intelligence budget |
| ai-hub down entirely | 3 infra retries → task FAILED → run coordinator surfaces checkpoint |
| Extractor emits invalid JSON (guided decoding disabled in fixture) | SCHEMA_FAILURE → re-extract only, research attempt untouched |
| Researcher note is empty/garbage | min-evidence check → intelligence retry with strategy fallback |
| Two workers race one READY task | SKIP LOCKED: exactly one claims; verified by assertion on attempt count |
| Postgres restart mid-run | workers reconnect; no state loss; trace assemblable (ADR-017) |
| Evaluator returns malformed decision | SCHEMA_FAILURE on a frontier gate → infra-style retry once → ESCALATE |
| Budget cap hit mid-wave | in-flight attempts finish; no new claims; WAITING_HUMAN checkpoint with options |
| Run cancelled during wave 2 | non-terminal tasks → CANCELLED; workers abort via signal; artifacts retained |

---

# 9. Definition of Done (V0.05)

The design doc's §20 checklist plus §24.9, verified by scripts not vibes:

1. Golden task G2 achieves the milestone loop unaided (gap → new task → improved accept).
2. Phase-1 crash script passes on every commit (CI).
3. Random-sentence provenance walk succeeds via read APIs only.
4. Trace of a superseded attempt renders fully after process restart.
5. Citation validator rejects a doctored report in the test suite.
6. All four golden tasks within budget assertions.

---

# 10. Deferred Triggers (write down now, decide later)

| Add | When — and not before |
|---|---|
| pg-boss / BullMQ | poll pressure measured, or >4 workers |
| Critic/Judge split | V0.05 transcripts show the merged Evaluator rubber-stamping its own issue list (ADR-015 criterion) |
| Embedding-based canonicalization | measured trigram misses on golden tasks |
| Temporal | runs span days, or human signals arrive hours later routinely |
| Contradiction entity + resolution workflow | contested-claim volume makes the note field unmanageable |
| k3s deployment | compose limits actually bite; rides the existing K8S-STUDY-GUIDE track |
| Best-of-N ensemble | single-attempt quality plateaus on golden tasks |

---

# 11. First Session Checklist

```text
□ git init + scaffold (ticket 0.1)         □ compose up postgres (0.2)
□ drizzle schema + migration 0001 (0.3)    □ schemas package: enums + errors (0.4)
□ config + logging (0.5)                   □ commit: "P0: foundation"
→ next session: 1.1 state machines — the first real test file in the repo.
```

The first line of product code is a pure function with a unit test, and the first week produces a distributed task engine you can crash-test — before any model is ever called. That ordering is the plan's whole thesis.
