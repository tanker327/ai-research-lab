# Phase 7 Plan — Interactive Plan Review + Per-Role Model Routing

User-requested feature (2026-08-20): after stage-1 planning, a run pauses for
human review; the user edits the plan interactively and sets the model tier
per agent role, then kicks the research off. Scope decisions made with user:
**stage-1 only** pauses (stage-2 deepening and evaluator follow-ups/REPLAN
stay autonomous once the direction is approved); scheduled as **Phase 7,
coding starts after the Phase 6 human watch leg signs off.**

Sources: design §6.1 (planner clarify), §13 (spec versioning — why spec edits
are deferred), §5.6 (routing policy), ADR-003 (humans act through the control
plane too), ADR-011 (concrete inputs), 6.4 checkpoint machinery (the pause and
verb infrastructure this phase extends). Status: **draft — reviewed with user
at proposal level; D-details below confirmed before coding starts.**

**Phase gate:** create a run with review on → it parks at `plan_review` after
stage-1 plan acceptance → via API: edit one task's question, remove one task,
add one task, set a role tier → approve → the run completes end-to-end and
(a) the edited question is what the researcher actually received (attempt
input), (b) the removed task never ran, (c) model_calls for the re-routed
role's attempts carry the chosen tier. Console leg: do the same interactively.

## Design decisions

### D1 — The pause is the existing checkpoint machinery, not a new state

`CreateRunRequest` gains `reviewPlan: boolean` (console default ON; API
default OFF so gates/scripts are unaffected). When ON, `applyAcceptedPlan`
for **stage 1 only** ends with: `plan_review` human checkpoint + run walk
→ WAITING_HUMAN (instead of RESEARCHING). Tasks are created exactly as today
(real rows, CREATED status).

### D2 — The hold is the readiness sweep's run filter (one line)

`promoteReadyTasks` currently skips only terminal runs; it gains
`'WAITING_HUMAN'` in the NOT IN list. A parked run performs no new work — a
rule that is independently correct (today a checkpoint-parked run's freshly
created tasks would still be claimed). Approval walks the run back to
RESEARCHING and the ordinary sweep promotes with dependency order intact — no
new task states, no special release logic.

### D3 — Plan editing = task CRUD on a parked run, fully audited

New endpoints, legal ONLY while the run holds a pending `plan_review`
checkpoint and the target task is CREATED:

- `PATCH /runs/:id/tasks/:taskId` — title, researchQuestion (input),
  priority, strategy, modelTier. Zod-validated; a blank/placeholder question
  is rejected (ADR-011 concreteness, same PLACEHOLDER guard as evaluator
  actions).
- `POST /runs/:id/tasks` — add a research task (concrete input required);
  dependsOn may name existing stage-1 tasks.
- `DELETE /runs/:id/tasks/:taskId` — CANCELLED (retirement, never row
  deletion).

Every edit: event (`PLAN_EDITED`, kind gate) + DecisionRecord
(`human_plan_edit`) with a human-readable diff summary — the transcript shows
human edits the same way it shows evaluator demands. Spec (objective/scope/
criteria) is DISPLAYED but read-only in V1: editing it triggers §13 spec
versioning — deferred, noted at the review screen.

### D4 — Per-role model selection is TIER selection, run-scoped

`CreateRunRequest` and the review screen accept `roleTiers`
(partial map role → frontier|strong_local|fast_local), persisted on
`research_runs.metadata.roleTiers`, editable while parked at plan_review
(PATCH /runs/:id/routing). Worker resolution order (extends 4.5's
`taskTierOverride`): task.model_tier ?? run.metadata.roleTiers[role] ??
ROUTING table. Existing belts stay: unconfigured tiers inert, dark-frontier
downgrade loud, retry-ladder escalations still write task-level overrides
(which win — an escalation outranks a preference). Raw model names remain
deployment config (.env aliases) — policy stays code+config, not user input.

### D5 — Approval is a 6.4 verb: `approve` on `plan_review`

`resolveCheckpoint` gains `approve`, legal only for `plan_review`: one tx —
checkpoint resolved (+note), DecisionRecord, `CHECKPOINT_RESOLVED` gate
event, run walk WAITING_HUMAN → RESEARCHING. `stop` works as everywhere.
`retry` stays illegal here (there is nothing failed). The console review
screen's "Start research" calls it.

### D6 — Console: Plan Review screen

Creating a run with review ON lands on `#/run/:id/review`: spec card
(read-only), editable task list (question textarea, priority, strategy,
per-task tier), role→tier table, add/remove task, "Start research" (approve)
and "Discard" (stop). The New Research form gains the review toggle +
optional role→tier selects. The RunDetail WAITING_HUMAN banner links to the
review screen when the pending reason is plan_review.

### D7 — What deliberately stays out

- Spec editing (→ §13 versioning, later phase).
- Pausing stage-2/REPLAN waves (user decision: autonomous after approval).
- Per-model (not per-tier) selection; per-attempt routing.
- Editing tasks after approval (once RESEARCHING, the loop owns the DAG).

## Ticket mapping (proposed)

| Ticket | Delivers | Decisions |
|---|---|---|
| 7.0 | This plan reviewed + tracker seeded (after P6 archive) | — |
| 7.1 | roleTiers end to end: schema field, worker resolution, creation-form selects | D4 |
| 7.2 | Review pause: reviewPlan flag, plan_review checkpoint, sweep hold, approve verb | D1 D2 D5 |
| 7.3 | Plan-edit endpoints (PATCH/POST/DELETE task, PATCH routing) + audit trail | D3 |
| 7.4 | Console: Plan Review screen + New Research form controls | D6 |
| gate | scripts/gates/p7.ts (API leg) + console leg with user | — |

## Test plan

- core: approve verb (tx, legality matrix extension of 6.4 tests); stage-1
  plan acceptance parks vs. flag off/stage-2 not parking; readiness sweep
  never promotes tasks of WAITING_HUMAN runs (concurrency: task created while
  parked stays CREATED).
- worker: tier resolution order (task override > run roleTiers > policy) and
  inert-unconfigured belt, with stubbed ModelClient.
- api: edit endpoints — legality (409 when not parked / task not CREATED),
  validation (placeholder question rejected), audit rows written.
- db: sweep filter regression in the failure-injection matrix.
- Console interactions covered by the gate's human leg (P6 precedent).

## Findings during the phase (append-only)

- **2026-08-20 — the attempt cap starved the tier escalation (fixed,
  41c2cd0).** Live on the user's RTX run: analysis attempt 1 hit the
  reasoning-exhaustion class (131-claim bundle, finish=length), attempt 2 was
  eaten by an externally SIGTERMed worker (TRANSIENT_INFRA via the
  stale-claim sweep), attempt 3 replayed the cached truncation in 40ms — and
  the designed SCHEMA_FAILURE→frontier escalation died on max_attempts.
  Design §14 already said infra "never counts against intelligence-retry
  budget"; the code now honors it: `enforceAttemptCap` excludes infra
  casualties (both call sites). Runaway stale-claim churn stays bounded by
  the infra axis itself (INFRA_BACKOFF ×3 → FAILED); the churn test drives 4
  kill rounds to prove it, and a wiring test replays the quality-path
  boundary (maxAttempts=2, one casualty → escalation survives and the
  frontier directive lands on the task row).
- **2026-08-20 (gate, API leg) — PASSED first run.** The review run parked at
  plan_review with its research task held CREATED (hold verified under a live
  scheduler); a question rewrite, a task add, a task remove, and an
  analyst→frontier re-route all landed with audit records; after approve the
  run COMPLETED and the edits proved real: the edited question was the
  researcher's verbatim attempt input (R12), the removed task ended CANCELLED
  with zero attempts, the added task ran, and the analyst's model_calls were
  tier `frontier`. Remaining: the console review leg with the user.
