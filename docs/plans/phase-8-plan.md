# Phase 8 Plan — Golden Suite + Hardening

Direction chosen by user 2026-08-20: lock in quality before growing features.
Builds implementation-plan §7 (the golden research task regression suite,
G1–G4, with recorded baselines and budget assertions) and closes the
known-issue tail. Starts after the Phase 7 console leg signs off. Status:
**draft — review notes below; direction already approved.**

**Phase gate:** G1 and G2 run live end to end with baselines recorded — G1
clean-accepts (target 1 cycle), G2 surfaces a contested claim and loops
(target 2 cycles) — and every budget assertion holds (≤ $1.50 frontier spend,
≤ 45 min wall clock, cycle guard never breached silently). The human
pass/fail on each recommendation (§7: part of the record) is the user's.

## Reality check (8.0 inventory)

- `scripts/golden/` holds only `model-smoke.ts` and `console-showcase.ts` —
  there is NO golden runner; CLAUDE.md's `bun run golden G2` is a stale
  aspiration. The suite is greenfield on top of very reusable gate plumbing.
- No baseline metrics exist anywhere; §7 requires each golden run to record
  cycles, retries, frontier calls, wall clock, spend, and a human verdict.

## Design decisions

### D1 — One runner, tasks as data

`scripts/golden/run.ts` + `bun run golden <ID>` (making CLAUDE.md true).
Task definitions live in `scripts/golden/tasks.ts` as data: id, title,
userRequest, expectations (targetCycles, expectContested?, expectCheckpoint?,
budgetUsd, wallClockMin). The runner reuses the gate pattern (own ports, own
stack, GATE_KEEP_RUN semantics) — spawn stack → create run → wait terminal or
parked → collect metrics via `/runs/:id/metrics` + verdicts + coverage →
assert budgets → write the baseline.

### D2 — Baselines are committed JSON

`scripts/golden/baselines/<id>/<date>.json`: the §7 record (cycles, retries,
tier split + spend, wall clock, evidence/claims/contested, verdict decisions,
report title + chip count) plus `humanVerdict: "pass" | "fail" | "pending"`
and a free-text note. The runner writes `pending`; `bun run golden <ID>
--judge pass|fail --note "…"` stamps the human call afterwards. Committed to
git — the log IS the regression history; before any prompt-version bump
(design §33) the suite reruns and the diff against the last baseline is the
review artifact.

### D3 — The four tasks (§7 verbatim, expectations encoded)

- **G1** R2 vs B2 vs Garage — staged planning + comparative research; expect
  clean ACCEPT, target 1 cycle, comparisons present in the analysis.
- **G2** LiveCodeBench score with vendor/independent discrepancy — expect
  ≥1 contested claim surfaced (never presented settled) and a follow-up loop
  (target 2 cycles).
- **G3** ECC UDIMM for W680-ACE at 96GB — recency pressure + community
  evidence; expect community-class sources in the mix.
- **G4** deliberately ambiguous "best storage" — expects the Planner's
  humanQuestions discipline: a scope_ambiguity checkpoint rather than a
  confidently wrong plan. (First live exercise of that P3 path.)
- Budget assertions on all four: ≤ $1.50 frontier spend, ≤ 45 min wall
  clock, `CYCLE_GUARD_TRIPPED` present whenever cycles hit the cap (never a
  silent breach).

### D4 — Hardening tail (the known-issue list, closed or re-filed)

- gate:p4 single-process ceremony: one uninterrupted run, then drop the
  known_issue (all assertions were long since verified manually).
- Flake hunt: run the full suite 5×; if the post-cap-fix flake reappears,
  capture the name and add its failure injection (retry-policy rule); if not,
  drop the note.
- CLAUDE.md commands section made accurate (golden runner syntax).
- The RTX and cycle-guard parked runs: resolved by the user from the console
  (Retry / Accept) — the golden suite needs the stack anyway; not code work.

### D5 — Deliberately out

- New agent capabilities, spec editing, productization — later phases.
- CI wiring for goldens (they spend money and need a human verdict; they
  stay manual by design, §7 "run on demand").

## Ticket mapping (proposed)

| Ticket | Delivers | Decisions |
|---|---|---|
| 8.0 | This plan + inventory | — |
| 8.1 | Runner + tasks-as-data + baseline writer + --judge stamping | D1 D2 |
| 8.2 | G1–G4 definitions with encoded expectations | D3 |
| 8.3 | Hardening tail: gate:p4 ceremony, 5× flake hunt, CLAUDE.md accuracy | D4 |
| gate | G1+G2 live with baselines + budgets green + human verdicts | — |

## Test plan

The suite IS the test (live, manual, budgeted). Unit coverage limited to the
runner's pure parts: expectation evaluation (given a metrics/verdict fixture,
which assertions fail) and baseline serialization — no live calls in vitest.

## Findings during the phase (append-only)

- **2026-08-20 — flake hunt clean.** Full suite (539 tests) ran 5× green;
  the unreproduced post-cap-fix flake never recurred — known issue dropped.
- **2026-08-20 — gate:p4 ceremony blocked by evaluator RUBBER-STAMPING (new
  known issue, not a code bug).** Attempt 1: leg B correctly parked at the
  cycle guard, then the whole stack was externally SIGTERMed mid-leg-A (the
  known machine quirk). Retries 1 and 2 both failed identically: the local
  evaluator ACCEPTed the deliberately impossible rubric, so the guard never
  got exercised. Two identical failures = stop per retry-policy. The gate's
  assertions were long since verified manually, so this does not block the
  phase — but "evaluator rubber-stamps an impossible rubric" is a live
  model-quality finding the goldens will measure (an over-lenient evaluator
  shows up as G2 clean-accepting instead of looping). Possibly the temp-0
  cached-replay class. Re-filed in known_issues.
- **2026-08-20 — G1 first live run: FAILED its assertion honestly (baseline
  committed, verdict pending).** Run 01a020a2: cycle 1 evaluated → follow-up
  loop → the cycle-2 analyze died on the large-bundle class at BOTH tiers
  over an 86-claim bundle: strong_local hit finish=length twice (24k output
  cap, second a 0s cached replay), the 41c2cd0 cap fix correctly excluded a
  frontier transport casualty, and the frontier retry finished (stop,
  ~17k tokens out) but still failed Zod. Run parked at analysis_failed —
  retryable from the console. Budget fine ($0.43, 41min). The suite exists
  to catch exactly this: analyst contexts near 90 claims are over the
  reliable ceiling for structured output; candidate fixes (claim-bundle
  chunking, output-size budget in the analyst contract) are next-phase work,
  not a quick patch.
