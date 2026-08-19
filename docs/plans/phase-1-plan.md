# Phase 1 Plan — Deterministic Task Engine

**Status:** Approved 2026-08-19 · **Source tickets:** implementation-plan §6 Phase 1 · **Interfaces:** implementation-plan §5.1–5.4
**Thesis:** by the end of this phase we have a distributed, crash-safe task engine we can torture-test — with zero LLM involvement (no imports from `agents`/`model`/`tools` anywhere in the execution path; enforced by import-lint).

---

## Design decisions (settled before coding)

### D1 — Raw SQL lives in `packages/db/src/raw/`; core owns orchestration

CLAUDE.md hard rule 4 and implementation-plan §5.2/§5.3 disagree on where the hot
queries live (§5 sketches them inline in `packages/core`). CLAUDE.md wins on
authority order:

- `packages/db/src/raw/` exports one **tagged-template query function per hot
  query** (claim-select, claim-update, stale-sweep, readiness-sweep, supersede,
  block-on-failed-dep) with typed row mappers. No business logic there.
- `packages/core` (`claim.ts`, `liveness.ts`, `scheduler/`) owns **transaction
  orchestration**: it opens the transaction, calls the raw functions, calls
  `assertTransition`, emits events — the same shape as §5.2/§5.3, with the SQL
  bodies imported instead of inlined.
- Consequence: core depends on `@lab/db` (allowed — only `agents`/`model`/`tools`
  are forbidden) and stays testable against real Postgres without any LLM code.

### D2 — Cross-process event fanout via Postgres LISTEN/NOTIFY, poll fallback

Ticket 1.6 says "in-process SSE fanout", but events are **written by worker
processes** and **served as SSE by the api process** — in-process fanout alone
cannot see worker events. Decision (no new dependency, fits the locked stack):

- `emitEvent` writes the event row **and** `NOTIFY lab_events, '<run_id>'` in the
  same transaction (payload = run_id only; listeners re-read rows — the table
  stays the source of truth, NOTIFY is just a doorbell; 8000-byte payload limit
  never matters).
- The api holds one dedicated LISTEN connection; on notify (and on a 2s fallback
  poll timer, in case a NOTIFY is missed during reconnect) it reads new event
  rows by `id > last_seen` (UUIDv7 = chronological) per subscribed run and fans
  out to SSE clients in-process.
- Recorded as `// OPEN-QUESTION(§22)` resolution at the site; promote to an ADR
  only if the mechanism grows.

---

## Sessions and tickets

Each session ends with `bun run check` green and a `P1.x:` commit per ticket.
Order inside a session is fixed; sessions run in order A → D.

### Session A — pure logic (tickets 1.1, 1.5) · no DB required

**1.1 — state machines + `assertTransition`** (`packages/core/src/state/`)
- Implement §5.1 verbatim: task transition table, plus the analogous attempt
  machine (CREATED→RUNNING→SUCCEEDED/FAILED; SUCCEEDED→ACCEPTED/REJECTED/
  SUPERSEDED; FAILED→SUPERSEDED; any non-terminal→CANCELLED) and run machine
  (CREATED→PLANNING→…→COMPLETED/FAILED/CANCELLED, WAITING_HUMAN loops back).
  Statuses import from `@lab/schemas` — no local redeclaration (rule 2).
- `InvalidTransitionError` extends `CategorizedError` with category
  `PERMANENT_INFRA` and `{from, to}` detail — an illegal transition is a bug
  surfaced loudly, never a retryable state.
- **Accept:** exhaustive tests — every cell of the legal-transition matrix and a
  sample of illegal ones; terminal states have no exits.

**1.5 — retry ladder `decideRetry`** (`packages/core/src/retry.ts`)
- Implement §5.4 verbatim (infra backoff 5s/30s/2m ×3; SCHEMA_FAILURE on extract
  ⇒ re-extract; quality-reject ladder: strategy fallback → tier escalation →
  task_failed). `ResearchStrategy` enum joins `@lab/schemas`.
- Every verdict is returned with a human-readable `rationale` string so callers
  can write the `DecisionRecord` (1.5 defines the shape; persistence lands in
  Session C/D where transactions exist).
- **Accept:** unit tests for every branch, incl. boundary attempt numbers and
  the "infra retries don't consume intelligence budget" property.

### Session B — concurrency core (tickets 1.2, 1.3) · real Postgres

**1.2 — atomic claim + worker loop**
- Raw queries in `packages/db/src/raw/claim.ts` (D1); orchestration in
  `packages/core/src/claim.ts` per §5.2: claim → create attempt
  (`attempt_number = attempt_count + 1`, bump `attempt_count`) → TASK_CLAIMED
  event, one transaction.
- Worker loop in `apps/worker`: poll every `POLL_INTERVAL_MS`, claim, dispatch to
  a **handler registry keyed by task type** — Phase 1 registers only fake
  handlers (sleep-N-ms, fail-with-category, write-fake-side-effect-row).
- **Accept (failure-injection begins):** two workers race one READY task —
  SKIP LOCKED yields exactly one claim, attempt count 1 (matrix row 6). Claim on
  empty READY set returns null cheaply.

**1.3 — readiness sweep + stale-claim release** (`packages/core/src/scheduler/`)
- Raw queries §9.2/§9.3 in `packages/db/src/raw/sweeps.ts`; scheduler runs both
  on the poll interval (readiness) / every 30s (stale) inside the api process.
- Also: deps-include-FAILED → BLOCKED (the §9.3 footnote); stale release marks
  the RUNNING attempt FAILED(TRANSIENT_INFRA) + `kind:'warn'` event.
- **Accept:** dependency chain becomes READY in waves; a task whose claim
  expired (`claimed_at` older than `TASK_CLAIM_TIMEOUT_S`) returns to READY with
  its attempt failed; SIGKILL-mid-attempt fixture passes (matrix row 1 — no
  duplicate live rows because the re-run writes a new attempt).

### Session C — liveness + events (tickets 1.4, 1.6)

**1.4 — accept/supersede liveness transaction**
- §5.3 verbatim, orchestrated in `packages/core/src/liveness.ts` over raw
  functions (`packages/db/src/raw/liveness.ts`). `enqueueCanonicalization` is a
  no-op stub emitting an event until Phase 3.
- **Accept:** the migration-level tests get their transactional counterpart —
  accept supersedes prior SUCCEEDED/FAILED/REJECTED attempts atomically; a
  concurrent double-accept loses at commit on `idx_attempts_one_accepted`;
  `live_*` views flip in the same transaction (readers never see a mixed state).

**1.6 — event emitter + SSE fanout**
- `emitEvent(tx, …)` in core: UUIDv7 id, requires `kind`, same-transaction write
  + NOTIFY (D2). Every state change in tickets 1.2–1.4 already routes through it.
- Api-side: LISTEN connection + per-run subscriber registry + `GET
  /runs/:id/events/stream` (Hono `streamSSE`) delivering events after an
  optional `Last-Event-ID` (UUIDv7 cursor — reconnect-safe).
- **Accept:** integration test — worker process writes events, api test client
  receives them over SSE in order; killed LISTEN connection recovers via the
  fallback poll without missing rows.

### Session D — assembly (tickets 1.7, 1.8) + phase gate

**1.7 — run coordinator** (`packages/core/src/scheduler/run.ts`)
- Run-level phase transitions driven by task-set state (all wave tasks DONE ⇒
  next phase event), cancellation (non-terminal tasks → CANCELLED, workers abort
  via claim check; matrix row 10), cycle-guard counter + `budget.ts` stubs that
  read caps from `research_runs.budget` but only emit warn events in Phase 1.
- **Accept:** cancel mid-wave passes matrix row 10; cycle guard increments and
  hard-stops at `DEFAULT_MAX_EVAL_CYCLES` in a unit test (real enforcement is
  exercised end-to-end in Phase 4).

**1.8 — API surface**
- `POST /runs` (create run + seed tasks — Phase 1 accepts an explicit task list
  in the request; the Planner replaces this in Phase 3), `GET /runs/:id`,
  `GET /runs/:id/tasks`, `GET /runs/:id/events`, `POST /runs/:id/cancel`,
  plus the SSE route from 1.6. DTOs in `@lab/schemas`.
- **Accept:** route tests via Hono `app.request()` against real Postgres.

**Phase gate — `scripts/gates/p1.ts`** (scripted, wired as `bun run gate:p1`):
create run → seed 5 fake tasks with a dependency chain → start 2 real worker
processes → SIGKILL worker A mid-task → stale claim releases → retry succeeds →
run COMPLETED. Assert: no duplicate live side-effect rows; every transition in
the event log is legal (replay through `assertTransition`); the event log alone
tells the full story (assemble a timeline and check required beats).

---

## Failure-injection coverage this phase

From implementation-plan §8 — Phase 1 owns rows 1, 6, 7, 10 (the rest need
Phases 2–4 machinery):

| Row | Injection | Where tested |
|---|---|---|
| 1 | SIGKILL worker mid-attempt | 1.3 fixture + phase gate |
| 6 | Two workers race one READY task | 1.2 fixture |
| 7 | Postgres restart mid-run | phase gate variant (restart container; workers reconnect, no state loss) |
| 10 | Run cancelled during wave 2 | 1.7 fixture |

New concurrency bugs found during the phase get their injection added to this
matrix in the same PR as the fix (CLAUDE.md testing rules).

## Explicitly out of scope for Phase 1

- Any LLM call, prompt, or agent code; `packages/context`/`evidence` stay stubs.
- Real budget enforcement (stubs only; Phase 4 wires enforcement).
- Canonicalization (no-op stub behind an event).
- Queues/frameworks — poll pressure is the §10 trigger, not a hunch.

## Risks / watch items

- **Drizzle transaction + postgres.js LISTEN:** the LISTEN connection must be a
  dedicated raw `postgres()` connection (not from the pool drizzle uses) or
  notifications stall behind queries. Isolated in one api-side module.
- **Test flakiness = findings:** timing-sensitive concurrency tests are not
  reruns-until-green material; each flake becomes a deterministic injection
  (retry-policy rule).
- **Phase 2 pre-flight (do late in Phase 1, ~30 min):** verify ai-hub
  reachability + vLLM `response_format: json_schema` support from this machine,
  so Phase 2's estimate holds.

## Definition of done

All 8 tickets merged with their tests; `bun run gate:p1` green twice in a row
locally (flake check); `bun run check` green; progress tracker updated and
Phase 1 tasks archived per `.claude/rules/progress-tracking.md`.
