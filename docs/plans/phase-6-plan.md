# Phase 6 Plan — Console UI Completion

Source of truth: implementation-plan §6 Phase 6 (amended 2026-08-19: console
built incrementally since P2 — this phase closes the remaining gaps), design
§24.6 (the mockup `docs/research-lab-console.html` is normative), ADR-017
(console is a pure projection of the read APIs), ADR-019 (staged columns).
Status: **draft — review with user before coding.**

**Phase gate (implementation-plan):** watch a live run end-to-end in the
console; open a superseded attempt's trace after an API restart (ADR-017 +
§24.9). The watch is a human check done together with the user; the
restart-survival leg is scripted.

## Inventory — built vs normative (§24.6)

Already live in `apps/web` (phases 2–5): runs list · new-research (freeform →
planner-driven run) · run detail with phase rail · task cards · kind-colored
timeline with SSE tail · attempts inspector with model/tool calls · claims &
evidence browser (contested amber, vendor flags) · verdict cards with
coverage · report with interactive citation chips · transcript reading mode ·
WAITING_HUMAN banner.

Gaps found in the 6.0 inventory:

| # | Gap | §24.6 line |
|---|---|---|
| G1 | Tasks tab groups by **status**; ADR-019 demands **staged columns** (plan stages ARE the semantics) | "Task graph is staged columns" |
| G2 | No per-task **inspector drawer** (attempts, superseded dimmed, tier/strategy badges, "View full trace") | "Inspector drawer" |
| G3 | No **trace viewer** (color-coded blocks, collapsible, Esc) — transcript exists but no per-attempt modal from a task click | "Trace viewer" |
| G4 | Overview missing **metric cards** (tasks/attempts/evidence+claims/frontier-vs-local calls + spend/wall clock/cycle-guard headroom) and the **latest verdict** card | "Overview" |
| G5 | **BUG:** Timeline SSE listens to a hardcoded Phase-1 event-type list — every P4/P5 event type (EVALUATION_DECISION, FOLLOWUP_TASK_CREATED, REPORT_ACCEPTED, CYCLE_GUARD_TRIPPED, …) never streams; history doesn't poll either, so a watched run looks frozen | "Timeline" + the gate itself |
| G6 | Report chips open a panel but don't **jump-and-flash the backing claim** in the evidence browser | "Report" |
| G7 | No **checkpoint resolution UI** — WAITING_HUMAN runs are resolved via SQL (banner admits it) | tracker known_issue |
| G8 | Floor: no keyboard nav (1–8, Esc), sidebar still shows stale "Coming online · P5" placeholders and "phase 3" footer | "Floor" |

## Design decisions

### D1 — Staged task board (G1): columns = plan stages, cards keyed by status

Columns are `plan_stage` (1..N, from the tasks payload — `selectTasksByRun`
gains `planStage` + `agentRole` + `strategy` + `modelTier`); inside a column,
tasks sort by creation and carry status color, type, attempt count. The
evaluator-driven follow-ups land in their stage column exactly where staged
planning put them — the DAG's waves become visible (ADR-019). Status remains
a badge, not the grouping.

### D2 — Inspector drawer + trace viewer (G2/G3): one data source, two shells

Clicking a task card opens a right-side drawer (mockup .drawer): task header
(type, stage, strategy, tier override if any), its attempts newest-first,
superseded/rejected dimmed, per-attempt "View full trace". The trace opens in
a modal viewer rendering the SAME `TraceDto` the transcript uses — one
component (`TraceBlocks`) shared between Transcript cards and the viewer;
blocks color-coded by kind (context/reasoning/tool/output/control; control
red on rejection), collapsible, Esc closes viewer then drawer. No new API.

### D3 — Overview metrics + latest verdict (G4): one new read endpoint

`GET /runs/:id/metrics` returns computed aggregates in one call: task counts
(by status + research vs control), attempt count + intelligence retries +
tier escalations, live evidence + claim + contested counts, model calls split
frontier/local + frontier spend (sum costUsd), tool calls + total scrape
latency (Firecrawl visibility — closes the P4 known_issue), wall clock, eval
cycles used vs max (guard headroom). Implementation: one raw SQL function
`selectRunDashboard` in `packages/db/src/raw/` (hot-path style, single round
trip). Overview renders the mockup's metric grid + a latest-verdict card
(decision, reasons, accepted uncertainties) linking to the Verdict tab.

### D4 — Timeline SSE robustness (G5): the API names every event, the client listens generically

Root cause: EventSource fires only *named* listeners and the client hardcodes
names. Fix on the API: keep the typed event name (existing tests rely on it)
but ALSO send each payload as a default `message` event — one extra write per
event, zero schema change. Client switches to `es.onmessage`, drops the list.
Timeline history query also gets a slow refetch as belt (SSE remains the
primary). This is load-bearing for the gate's "watch a live run".

### D5 — Checkpoint resolution (G7): minimal verbs, control plane interprets

New write endpoint `POST /runs/:id/checkpoints/:checkpointId/resolve` with
`{action, note}`; actions are deliberately few (V0.05):

- `retry` — for `analysis_failed`/`synthesis_failed`: reset the failed loop
  task's attempts budget (new maxAttempts window), task back to READY... no —
  simplest legal move: CANCEL the failed task; the completion sweep's
  existing invariants re-enqueue a fresh analyze/synthesize task. Run walks
  WAITING_HUMAN → the phase it parked from. For `cycle_guard`: bump the
  run's cycle allowance by upping `metadata.extraEvalCycles`? — NO: V0.05
  keeps the guard hard; `retry` is not offered for cycle_guard.
- `accept` — for `cycle_guard` only: force-continue to synthesis with the
  material on hand (run → SYNTHESIZING + synthesize task), recording the
  human decision as an `evaluations` row (evaluator_type='human').
- `stop` — cancel the run (existing cancelRun).

Every resolution: checkpoint → resolved (+note), a DecisionRecord with the
human rationale, an event (kind gate — a human judgment point), all one tx,
via `assertTransition` walks only. The banner gains buttons per checkpoint
reason. This is new control-plane surface — flagged here for review, kept to
these three verbs; richer semantics stay deferred (§22).

### D6 — Report chip jump (G6) + floor (G8)

- Chip panel gains "jump to claim" → navigates to Evidence tab with
  `#claim-<id>`; ClaimsView scrolls to and flashes the anchored claim
  (respecting prefers-reduced-motion).
- Keyboard: 1–8 switch run-detail tabs, Esc closes viewer/drawer.
- Sidebar: retire "Coming online" placeholders and the stale phase footer
  (show live run count instead).

### D7 — Gate strategy

`scripts/gates/p6.ts`, two legs:

- **Leg A (scripted):** seed + run a small live run; mid-run, SIGTERM and
  restart the API process; after completion, fetch a SUPERSEDED attempt's
  trace via the restarted API and assert the §24.2 blocks are complete
  (ADR-017: everything the console shows survives a restart because it was
  never in memory). Also asserts /metrics and the default-message SSE frames.
- **Leg B (human):** watch a live run end-to-end in the console with the
  user — phases advance on the rail, events stream without refresh, verdict
  and report appear, a checkpoint (if any) is resolvable from the banner.
  The phase is done when the user signs off on the watch.

## Ticket mapping (proposed 6.1–6.5)

| Ticket | Delivers | Decisions |
|---|---|---|
| 6.1 | Staged task board + inspector drawer + shared trace viewer | D1 D2 |
| 6.2 | /runs/:id/metrics + overview metric grid + latest-verdict card | D3 |
| 6.3 | SSE generic-message fix + timeline robustness | D4 |
| 6.4 | Checkpoint resolution: resolve endpoint + banner actions | D5 |
| 6.5 | Chip jump-and-flash, keyboard nav, sidebar cleanup | D6 |
| gate | scripts/gates/p6.ts leg A + guided watch leg B | D7 |

## Findings during the phase (append-only)

- **2026-08-20 (6.0) — Timeline SSE was silently frozen for P4/P5 events**
  (hardcoded Phase-1 event-name list + no history refetch). Filed as G5/6.3;
  load-bearing for the gate.

## Test plan

- db: selectRunDashboard aggregates against seeded runs (test DB).
- api: metrics endpoint shape; SSE default-message frames (extend
  events.test.ts); resolve endpoint per action × reason matrix incl. illegal
  combinations (409) and transition legality.
- core: checkpoint resolution tx behavior (resolved + DecisionRecord + event
  + legal run walk) per action.
- web: `bun run check` typecheck/build floor (component tests remain out of
  scope, per console precedent — the gate's human leg covers interaction).
