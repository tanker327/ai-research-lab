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

## Gate-fix work (added 2026-08-20 after the first G1/G2 baselines)

The first live suite run caught two quality failures; the gate stays open
until they are fixed and the goldens rerun green. Root causes, from the
evidence (not symptoms):

**G1 (analyst):** the cycle-2 analyze died at both tiers over an 86-claim
bundle — but for different reasons. strong_local hit finish=length at the
24k OUTPUT_BUDGET (reasoning + 20×2000-char findings don't fit), then
replayed the identical failure from cache in 0s (temp-0, identical prompt).
The frontier attempt COMPLETED (~17k tokens, finish=stop) and failed Zod on
exactly two strings: `canonicalClaimIds` entries over 40 chars (two UUIDs
glued into one string) — a 99%-valid analysis rejected all-or-nothing, with
the retry replaying the same prompt verbatim.

**G2 (independence chain):** the contradiction system works (canonicalize.ts
marks disagreeing values contested) but never got input — the researcher
only fetched DeepSeek's own model card and paper (9/9 evidence rows
vendor-affiliated), the `check:non_vendor` rule is advisory (warn) by the P3
finding, and the evaluator ACCEPTed with the 9/9 vendor ratio visible in its
coverage facts. Same-day, gate:p4 leg B's evaluator ACCEPTed an impossible
rubric twice. The evaluator is the failing backstop; the researcher is the
failing front line.

### D6 — Analyst robustness (fixes G1)

- **Schema-feedback retries:** `AnalystInput` gains
  `schemaFeedback: z.array(shortText).default([])` (the P5
  `rejectionFeedback` pattern). On a SCHEMA_FAILURE retry the context
  builder feeds the previous attempt's Zod issue paths ("canonicalClaimIds
  entries must be single ids, ≤40 chars"); on finish=length it feeds a
  conciseness directive instead ("previous attempt exceeded the output
  budget — shorter statements, ids only, no restating claims"). A changed
  prompt also breaks the temp-0 cached-replay loop for free.
- **Distinguish truncation from malformation:** the model client already
  sees finish_reason; a `length` finish becomes SCHEMA_FAILURE with
  `detail.truncated: true` so the retry path can pick the right feedback.
- **Prompt version bump:** analyst v1 has accepted attempts → the feedback
  field + tightened id/conciseness instructions land as `analyst/v2`
  (design §33); the golden rerun + baseline diff is the review artifact.
- NOT doing: claim-bundle chunking (changes cross-claim semantics; deferred
  trigger: v2 still failing on large bundles), raising OUTPUT_BUDGET
  (reasoning models will spend whatever they're given).

### D7 — Source-independence chain (fixes G2, deterministically first)

- **Vendor-only benchmark claims are born contested (code, not prompt —
  ADR-016 spirit):** in canonicalization, a claim of type
  benchmark/measurement whose live evidence is ALL vendor-affiliated
  (NULL = vendor, existing safety rule) gets `status = contested`,
  contest note "vendor-only sourcing — no independent confirmation".
  Everything downstream already reacts to contested: the analyst sees
  openContests, the evaluator sees the contested count, ADR-020 forces it
  into ## Uncertainties. Scoped to measured-value claim types ONLY — the
  P3 finding stands (postgresql.org is "vendor" for a PostgreSQL question;
  doc/fact claims stay advisory-warn).
- **Researcher v2:** for benchmark/measured-value questions, the strategy
  instructions demand an attempted independent source (leaderboard,
  third-party eval) before self-assessing complete.

### D8 — Evaluator anti-rubber-stamp (fixes G2's backstop + gate:p4 leg B)

- **Deterministic backstop (code):** `evaluatorPreAcceptChecks` — an ACCEPT
  while contested claims exist that appear nowhere in
  `acceptedUncertainties` is rejected (`check:contested_unaddressed`,
  QUALITY_FAILURE → the ladder retries/escalates). The guard that stops a
  lenient model is code, never the model (ADR-016).
- **Evaluator v2:** output gains a per-criterion verdict array (each
  success criterion: satisfied | unsatisfied | not_assessable + a claim/
  evidence pointer). Rubber-stamping an impossible rubric then requires
  fabricating per-criterion evidence pointers — structurally harder, and
  auditable in the trace. ACCEPT additionally requires every criterion row
  present (deterministic check).
- Verification: gate:p4 leg B rerun (the impossible rubric must again trip
  the guard) + G2 rerun (must contest + loop).

## Ticket mapping (proposed)

| Ticket | Delivers | Decisions |
|---|---|---|
| 8.0 | This plan + inventory | — |
| 8.1 | Runner + tasks-as-data + baseline writer + --judge stamping | D1 D2 |
| 8.2 | G1–G4 definitions with encoded expectations | D3 |
| 8.3 | Hardening tail: gate:p4 ceremony, 5× flake hunt, CLAUDE.md accuracy | D4 |
| 8.4 | Analyst robustness: schema/truncation feedback retries, analyst v2 | D6 |
| 8.5 | Independence chain: vendor-contest guard, researcher v2, evaluator backstop + v2 | D7 D8 |
| gate | G1+G2 rerun green (G1 completes, G2 contests + loops) + gate:p4 leg B passes + budgets + human verdicts | — |

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
- **2026-08-20 — G2 first live run: FAILED its contest assertion (baseline
  committed, verdict pending).** Run 01a020cd COMPLETED in 12min/$0.15 —
  but in ONE cycle with ZERO contested claims: the report presents the
  vendor's number as settled ("DeepSeek-R1 LiveCodeBench Score: 65.9
  Pass@1-COT from Official Model Card", 9 chips, 9 evidence rows). The
  vendor rule never fired and the evaluator accepted vendor-only sourcing
  without demanding independent coverage — consistent with the same-day
  rubber-stamp observations at gate:p4 leg B. This is the exact failure G2
  was designed to expose (§7: contest surfaced, target 2 cycles). Candidate
  causes to investigate next phase: evaluator leniency, and/or the
  researcher never reaching independent leaderboard sources.
- **2026-08-21 — gate:p4 PASSED end to end on evaluator/v2** (single
  uninterrupted run): leg B's impossible rubric was refused and the
  deterministic guard tripped at cap (WAITING_HUMAN + cycle_guard + fail
  event); leg A's milestone held (RESEARCH_MORE → follow-up → ACCEPT on
  cycle 2, coverage 19→46 evidence). This closes BOTH the rubber-stamp known
  issue (the D8 per-criterion discipline held live) and the long-outstanding
  gate:p4 single-process ceremony (D4).
- **2026-08-21 — G2 rerun on the v2 chain: the independence machinery fired,
  and its cost blew the wall clock (baseline committed, verdict pending).**
  Run 01a0241d: the researcher reached independent sources
  (vendor_affiliated=false evidence exists now), 15 claims ended contested
  (was 0), and the evaluator looped — 2 accepted cycles plus a third in
  flight when the runner's 45-min ceiling hit ($0.63 spent, budget fine).
  Two honest failures: wall clock exceeded, run still EVALUATING at timeout.
  The pendulum swung from rubber-stamp to over-thoroughness: 22 intelligence
  retries (10 escalations) and 15 contests is a lot of machinery for one
  benchmark question. Watch items for the next iteration: contest volume
  (is the vendor-only rule too broad on satellite claims?), retry pressure
  on big cycle-2+ bundles, and whether targetCycles=2 should imply a longer
  wall-clock allowance for loop-expected goldens. The orphaned run may be
  completed by the dev stack's workers via the stale-claim sweep.
