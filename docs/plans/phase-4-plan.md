# Phase 4 Plan — Analyst · Evaluator · Autonomous Loop

**Status:** Draft for review 2026-08-19 · **Source tickets:** implementation-plan §6 Phase 4 · **Contracts:** system-design §6.4–6.5, §12, §13, §14; database-schema §7, §9.4
**Thesis:** by the end of this phase the system closes its defining loop — THE MILESTONE from the design doc:

> The Evaluator discovers a missing piece of evidence that was not in the original plan, the system autonomously creates a new research task, executes it, updates its analysis, and the Evaluator later accepts the improved result.

The Analyst reads live claims and produces findings; a deterministic CoverageSummary is computed from live evidence; the Evaluator (merged critic+judge, frontier tier) judges analysis + coverage and returns a decision; the Control Plane — never the agent — interprets that decision into follow-up tasks, replans, or acceptance; and a deterministic cycle guard (ADR-016) caps the loop at N cycles with a `WAITING_HUMAN` checkpoint.

---

## Pre-flight constraints (what Phase 3 left us)

| Constraint | Consequence here |
|---|---|
| Frontier = `deepseek/deepseek-v4-pro`, live and verified (gate:p2 green) | Evaluator runs on frontier as designed — **no dark-frontier decision needed**. `guardDarkFrontier` stays as the fallback if `FRONTIER_ENABLED=0`. |
| `FRONTIER_STRUCTURED_MODE=json_object` — our client parses (fence-strip → outermost `{}` → Zod) | Evaluator output schema must survive json_object mode: closed object, no records, bounded everywhere (P3 norm) |
| Fast/reasoning models exhaust budgets on verbose prompts | Evaluator prompt states the rubric tersely; `OUTPUT_BUDGET` carries reasoning headroom (16k — deepseek-pro reasons hard) |
| P3 run lifecycle: `sweepRunCompletion` completes runs when stage cap reached & tasks terminal | P4 rewires that endgame: work done + claims → **analyze task**, not COMPLETED → **D4** |
| Raw claims carry `task_id`; research task inputs carry `researchQuestion` | Key-question mapping for coverage is derivable deterministically — no new agent output needed → **D2** |
| ADR-010 degraded completion (failed leaves tolerated) | Analysis proceeds over whatever claims exist; the Evaluator sees failure counts in `runMetrics` and can demand more |
| `evaluations.metadata` JSONB exists (schema §7); task types `analyze`/`evaluate` and run statuses `ANALYZING`/`EVALUATING`/`WAITING_HUMAN` already in DDL | No migration needed except any missing seed/status wiring in `assertTransition` tables |

## Findings during the phase (append-only)

- **gate:p3 semantics superseded (4.4):** with the analysis loop live, a run with claims can no longer COMPLETE from the completion sweep — it is analyzed and judged first, and completion is the Evaluator's ACCEPT. `gate:p3`'s "run COMPLETED" assertion now exercises the full loop (and can land at WAITING_HUMAN if the guard trips); gate:p4 is the phase's live gate going forward.
- **RUN_DEGRADED fires once, at analysis entry** (not at completion as in P3): failed leaves stay loud, and the Evaluator sees them in `runMetrics.tasksFailed`.
- **First live gate run (2026-08-19): the full loop worked end to end unassisted** — plan → research → extract → canonicalize → analyze → evaluate → ACCEPT → COMPLETED, on the very first live pass. Two findings from it:
  - **Per-question coverage counted zero for every question** — evidence/claims carry the EXTRACT task's id (ADR-012 two-pass), not the research task's; the lineage walk now goes research → dependent extract tasks via `task_dependencies`. Spotted BY THE EVALUATOR itself in its issues list — the loop auditing its own instrumentation.
  - **A future-dated "impossible rubric" is not impossible to a good judge:** deepseek-pro ACCEPTed leg B's post-2027-benchmark criterion as *documented absence* with accepted uncertainties — a defensible judgment, not a rubber-stamp. Leg B's rubric is now MEASURABLY unmet in coverage (≥12 distinct non-vendor publishers, ≥5 benchmark origins) with absence-acceptance explicitly forbidden.

- **THE MILESTONE achieved live (2026-08-20):** leg A run `01a01ee3…` — the Evaluator demanded the uncovered PREPARE TRANSACTION facet on cycle 1, core created 11 follow-up tasks over three RESEARCH_MORE cycles, analysis regenerated each round, and cycle 4 ACCEPTed on quoted official evidence. Coverage per cycle: 10→32→44→55 evidence, 2→4 distinct publishers. The cycle guard leg passed four consecutive live runs. Late-phase findings, each a commit: SCHEMA_FAILURE attempt ≥2 escalates tier (deterministic models replay cached bad output); never await the network inside a DB transaction (a hung merge-confirm starved the scheduler pool 90+ min — canonicalization is now read → confirm → transactional write, with a 60s confirmer timeout); json_object outputs give semantically-optional arrays `.default([])`; unconfigured tier suggestions are inert; tests run in a dedicated `research_lab_test` DB after the suite twice poisoned a parked live run; the loop invariant ignores CANCELLED tasks.

## Design decisions

### D1 — Evaluator tier: frontier (deepseek-v4-pro), json_object mode — RESOLVED

The open question ("Evaluator tier while frontier dark") died when the frontier was rewired to deepseek-v4-pro. The routing table stays as §5 wrote it: `{ role: "evaluator", tier: "frontier" }`, `{ role: "analyst", tier: "strong_local" }`. `guardDarkFrontier` (worker-side) already downgrades loudly if `FRONTIER_ENABLED=0`, so the phase has no hard dependency on external keys. Evaluator calls are ~$0.002 each; a 3-cycle run costs under a cent.

### D2 — CoverageSummary shape: overall + per-key-question, keyed by research-task lineage

Deterministic, computed in `packages/evidence/src/coverage.ts` from `live_evidence` + `live_canonical_claims` (schema §9.4 SQL, extended). **The key question for a claim is the `researchQuestion` of the task that produced it** — walked `raw_claims.task_id → research_tasks.input.researchQuestion`. No claim→question mapping is asked of any agent (ADR-011 spirit: derive, don't prompt).

```ts
// packages/schemas — closed objects, bounded (P3 norm)
CoverageSummary {
  evidenceCount: number; claimCount: number; contestedCount: number;
  distinctPublishers: number; distinctOrigins: number;
  vendorRatio: number;            // NULL vendor_affiliated counted as vendor (safety, §9.4)
  sourceClassMix: Array<{ sourceClass: string; count: number }>;   // array, not record
  perQuestion: Array<{                                              // max 40
    question: string;             // the research task's researchQuestion (max 500)
    taskStatus: string;           // DONE | FAILED | ... — failure visibility (ADR-010)
    evidenceCount: number; claimCount: number;
    distinctPublishers: number; vendorRatio: number;
  }>;
  oldestEvidence: string | null; newestEvidence: string | null;    // ISO dates
}
```

Persisted verbatim on the evaluation row (`evaluations.metadata.coverage`, R13/§24.2) so cycles are comparable in the console. Age *distribution* (histogram) is deferred to V0.1 — oldest/newest bounds suffice for the Evaluator's recency reasoning now.

### D3 — RESEARCH_MORE interpretation: 1 requiredAction → 1 research task, same stage; the cycle is analyze→evaluate

Per design §14: follow-ups are created **directly by the Control Plane** from `requiredActions` — no Planner call. Interpretation rules (all in `packages/core`, one transaction):

- `RequiredAction` is a closed schema: `{ kind: "research", question (min 12, max 500), seedUrls (max 5, nullable), rationale }`. V0.05 has exactly one kind; the enum leaves room for `reanalyze_hint` later.
- Each action becomes one `research` task (input built like the plan interpreter: concrete, placeholder-guarded, PLACEHOLDER regex applied — an Evaluator that emits template-ish questions gets the attempt rejected as SCHEMA_FAILURE-adjacent quality reject, retried on the ladder).
- Follow-up tasks join the **current plan stage** (no new `plan_stages` row — §14: "no new stage"). They get normal extract-on-accept behavior from P3 unchanged.
- After all follow-ups (and their extracts) are terminal and canonicalization has run, the completion sweep enqueues **analysis v(N+1)** — a fresh `analyze` task. The old analysis attempt is superseded by acceptance of the new one (live_* views already handle this).
- `REANALYZE` → new analyze task immediately (no research). `REPLAN` → plan task for stage N+1 with `evaluatorFeedback` in its input (spec re-version per §13 — the planner may supersede in-flight tasks via the existing PlanDelta path). `ESCALATE` and `STOP` → human checkpoint (`WAITING_HUMAN`), reason `evaluator_escalation`. `ACCEPT` → run `COMPLETED` (P5 will insert synthesize here).

**Cycle definition & guard (ADR-016):** one cycle = one accepted evaluate attempt. The guard is `countEvaluationCycles(runId) >= DEFAULT_MAX_EVAL_CYCLES` (config, default 3), checked **in code before interpreting any non-ACCEPT decision**. On breach: force a human checkpoint (`WAITING_HUMAN`, reason `cycle_guard`) with a `CYCLE_GUARD_TRIPPED` fail-kind event — never silently accept, never let the model loop.

### D4 — Run endgame rewiring: sweepRunCompletion grows an analysis phase

P3's completion sweep is the insertion point. New endgame, all existing behavior preserved up to the stage cap:

```
research stages exhausted & all tasks terminal
  ├─ live claims == 0            → COMPLETED (degenerate, as today — nothing to analyze)
  └─ live claims  > 0            → enqueue analyze task, run → ANALYZING
analysis accepted                → compute CoverageSummary, enqueue evaluate task, run → EVALUATING
evaluate accepted                → interpret decision (D3)
  ├─ ACCEPT                      → COMPLETED
  ├─ RESEARCH_MORE / REPLAN      → run → RESEARCHING/PLANNING, loop continues (guard permitting)
  ├─ REANALYZE                   → run → ANALYZING
  └─ ESCALATE / STOP / guard     → WAITING_HUMAN (+ human_checkpoints row)
```

All transitions via `assertTransition` in-tx with events (rules 3, 8). Analyze/evaluate task failures after the retry ladder (attempt cap) → run `WAITING_HUMAN` (an un-analyzable run is a human's call, not silent FAILED — ADR-010's spirit at run scope).

### D5 — Analyst contract: claim bundle K=3, findings cite claims (checked in code)

`AnalystInput` per §6.4: specification + claim bundle + open contests. Context builder (`packages/context`) selects, per live claim, up to **K=3 strongest evidence** by the §12 heuristic (prefer distinct `benchmarkOrigin` → non-vendor-affiliated → most recent), plus all contested claims with their full disagreement. Reasoning artifacts never enter (ADR-018 — already enforced in `packages/context`).

`AnalysisOutput`: findings (each cites `canonicalClaimIds`, min 1 — **a finding with zero citations or an unknown claim ID is a deterministic pre-accept reject**, code not prompt), comparisons, unresolvedQuestions, confidenceNote (prose, no fake floats). All bounded, no records. The accepted analysis is stored as an `analysis_memo` artifact + the attempt output row; the evaluate task's input references the analysis attempt.

### D6 — Evaluator contract: §6.5 verbatim, plus what it may NOT do

`EvaluatorInput`: specification + analysis + claim digest + `coverage` (D2) + `runMetrics` (attempts used, failed-task count, cycles completed, budget spent). `EvaluatorOutput`: issues / decision / reasons / requiredActions / acceptedUncertainties — exactly §6.5, Zod-bounded. No web tools, no evidence_query in V0.05 (design §16: the Evaluator judges what was collected; gaps must flow through `requiredActions` into visible tasks).

Deterministic consistency checks before accept (code, not prompt): `RESEARCH_MORE`/`REPLAN` with zero requiredActions → reject (quality); `ACCEPT` with any `critical` issue open → reject (the rubber-stamp guard, ADR-015's split criterion made mechanical); requiredAction questions placeholder-scanned. Rejects ride the existing `rejectSucceededAttempt` + `decideRetry` ladder (rule 10).

### D7 — Golden task + gate strategy (THE MILESTONE must be honest)

The gate (`scripts/gates/p4.ts`) runs live like p3, two legs:

- **Leg A — the milestone.** A seeded question engineered to under-cover on stage 1+2 (narrow seed URLs, `MIN_EVIDENCE_PER_TASK=1`, question with a facet the seeds don't answer). Assert: ≥1 evaluate cycle ends `RESEARCH_MORE` with ≥1 requiredAction → core creates follow-up research task(s) (event `FOLLOWUP_TASK_CREATED`) → they execute → analysis v2 → **ACCEPT on cycle ≥2** → run COMPLETED. Also assert `evaluations.metadata.coverage` present per cycle and coverage strictly improved (evidenceCount↑ or vendorRatio↓) between cycle 1 and the accepting cycle.
- **Leg B — the guard.** Same run shape with `DEFAULT_MAX_EVAL_CYCLES=1` and a success criterion that cannot be satisfied ("include a benchmark published after 2027"). Assert: guard trips before interpreting cycle-1's non-ACCEPT → run `WAITING_HUMAN`, `human_checkpoints` row reason `cycle_guard`, `CYCLE_GUARD_TRIPPED` event kind `fail`. (Guard-at-1 makes the leg deterministic — it must trip regardless of which non-ACCEPT decision the live model picks; if the model ACCEPTs an impossible rubric, that's a gate failure worth seeing.)

Golden tasks G1/G2 (implementation-plan §7) get their `scripts/golden/` entries this phase — run manually, recording cycles/retries/frontier calls/spend.

## Ticket mapping (tracker 4.1–4.6)

| Ticket | Contents | Decisions |
|---|---|---|
| 4.1 | `CoverageSummary` schema + `computeCoverage(db, runId)` in `packages/evidence` (raw SQL in `packages/db/src/raw/coverage.ts`); persisted on evaluation rows | D2 |
| 4.2 | Analyst v1 (schemas, prompt, agent, context builder `forAnalyst` with K=3), findings-cite-claims deterministic check, worker handler | D5 |
| 4.3 | Evaluator v1 (schemas, prompt, agent, `forEvaluator` context), consistency checks, worker handler on frontier | D1, D6 |
| 4.4 | Core decision interpreter + endgame rewiring in `sweepRunCompletion` + cycle guard + human checkpoints; events: `ANALYSIS_ACCEPTED`, `EVALUATION_DECISION`, `FOLLOWUP_TASK_CREATED`, `CYCLE_GUARD_TRIPPED`, `RUN_WAITING_HUMAN` | D3, D4 |
| 4.5 | Intelligence-retry end to end: deterministic reject → strategy fallback → tier escalation (frontier now real); analyze/evaluate roles wired into `decideRetry`/cap paths; live verification that attempt-3 frontier escalation works | D1 |
| 4.6 | Console: run detail gains **Verdict** panel (decision, issues by severity, requiredActions, acceptedUncertainties), per-cycle coverage comparison, cycle rail in overview, WAITING_HUMAN banner; `GET /runs/:id/verdicts` + `GET /runs/:id/coverage` read APIs | standing UI rule |

Order: 4.1 → 4.2 → 4.3 → 4.4 → (4.5, 4.6 in parallel) → gate.

## Test plan

- Unit/integration (real Postgres, as always): coverage computation against seeded evidence (vendor-NULL counted as vendor; per-question lineage walk); decision interpreter — every decision × guard state; cycle guard idempotence; findings-citation check; evaluator consistency checks; endgame transitions (analyze-on-claims, WAITING_HUMAN on attempt-cap failure); follow-up tasks join current stage, no new plan_stages row.
- Agent contract tests with stubbed ModelClient (schema in/out, no-web allowlist for evaluator).
- Failure injection: worker dies mid-analyze; evaluator SCHEMA_FAILURE on frontier (infra-style retry once → ESCALATE per §8 matrix).
- Gate legs A + B (D7). `bun run gate:p4` spends a few cents (frontier evaluator calls).
