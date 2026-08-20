# Phase 5 Plan — Synthesizer + Citation Validator

Source of truth: implementation-plan §6 Phase 5 (tickets 5.1–5.3), system-design
§6.6 (Synthesizer contract), §24.4 (citation map + validator), §24.2 (trace read
model), §24.5 (read APIs), ADR-020 (validator gates synthesis), ADR-018
(reasoning never in contexts). Tracker adds 5.4 (console wiring, standing UI
rule). Status: **draft — review with user before coding.**

**Phase gate (tracker):** an end-to-end run produces a report where a sampled
factual sentence traces sentence → claim → live evidence → source → attempt via
API calls only; the validator demonstrably rejects a doctored uncited draft.

## Pre-flight state (what Phase 4 left us)

- ACCEPT currently walks EVALUATING → SYNTHESIZING → COMPLETED in one hop
  (`evaluation.ts:110`) — synthesis is skipped. 5.1 replaces that hop.
- `synthesize` already exists in the task-type enum, run-status enum, and the
  worker handler table (`notYetImplemented("synthesize", "5.x")`).
- `artifacts.type` already includes `'report'`; §9.5 documents the provenance
  walk SQL (report chip → source) but it is not yet in `packages/db/src/raw/`.
- Read APIs already live: claims, coverage (current + cycles), verdicts,
  checkpoints, attempts, calls, events + SSE. Missing from §24.5: trace,
  transcript, report/citations.
- P4 norms are law: `.default([])` on semantically-optional arrays; never await
  the network inside a DB tx; SCHEMA_FAILURE attempt ≥2 escalates to frontier;
  tests only in `research_lab_test`.

## Findings during the phase (append-only)

*(populated as we go, same discipline as Phase 4)*

- **2026-08-20 (5.2) — §24.4 "APPROVED claim" has no workflow behind it.** No
  code path ever stamps `canonical_claims.status = 'approved'`; claims live as
  proposed/supported/contested. Enforced interpretation: a chip must resolve
  to a **live** claim that is not `'rejected'` and has ≥1 **live** evidence
  link; `'contested'` claims are citable only from the Uncertainties section.
  Semantics preserved (no unprovenanced statements); revisit if an approval
  workflow ever lands.
- **2026-08-20 (5.2) — accepted-uncertainty reproduction is a count check.**
  Verbatim matching would punish faithful restating (an LLM judgment we must
  not make in code, D3): the deterministic proxy is that the Uncertainties
  section exists with at least as many entries as the verdict accepted.
- **2026-08-20 (gate) — PASSED, single process, first run.** Leg B: the live
  scheduler rejected the doctored draft with `check:uncited_sentences` +
  `check:chips_cite_live_claims`. Leg A: a planner-driven run completed
  through synthesis — report "PostgreSQL Transactional DDL: Yes, With a
  Database/Tablespace Exception", 4 chips; a randomly sampled sentence walked
  chip c3 → supported claim → wiki.postgresql.org evidence → attempt trace
  (4 blocks) via API calls only; 2 accepted uncertainties reproduced; 7
  transcript traces in stage order. Kept run: gate leg A (GATE_KEEP_RUN=1).
- **2026-08-20 (5.2) — validator rejects must be fixable, not replayed.** The
  P4 cached-replay lesson applied proactively: rule-check REJECT reasons from
  prior attempts of the same task are fed into the next synthesize context
  (`rejectionFeedback`) and rendered as a "previous draft was rejected" block.

## Design decisions

### D1 — Synthesizer tier: frontier (deepseek-v4-pro), json_object, NO tools

§11 pins the Synthesizer to frontier (1 call/run). Tool allowlist is **empty**
(§18: "no web — cannot import uncited facts"); the contract test asserts any
tool suggestion is a violation. json_object mode with the P4 `.default([])`
norm. Watch the DeepSeek balance — a 402 here parks the run at the last stage,
which is the most expensive place to strand it (mitigated by D4's checkpoint
path).

### D2 — Output contract: report markdown with inline chips + citationMap

§24.4's `SynthesizerOutput { reportArtifactId, citationMap }` describes the
*persisted* shape; the agent cannot mint artifact ids. The agent output schema
(in `@lab/schemas`) is:

```ts
SynthesizerOutput = {
  reportMarkdown: string,          // chips inline as [c1], [c2] … at sentence ends
  citationMap: Record<string, string[]>,  // chipId → canonicalClaimIds (validated ids)
  title: string,
}
```

- Chip syntax: `[c<N>]` tokens embedded in the markdown, one or more per cited
  sentence. Deterministically parseable; renders as clickable chips in the
  console (mockup interaction).
- The worker handler saves `reportMarkdown` as an `artifacts` row
  (`type='report'`, carries `attempt_id`) and persists the citationMap in the
  attempt output — the artifact id + map is what §24.4's persisted shape means.
- Required report structure (validator-enforced, not prompt-hoped): a
  `## Findings`-style body, and an `## Uncertainties` section that reproduces
  every `acceptedUncertainty` from the final ACCEPT verdict (§6.6: "a promise
  to the user, not a footnote to drop").

### D3 — Citation validator: deterministic, structural, in `packages/core/src/checks`

ADR-020: code, not model. The hard part is "factual sentence" — an LLM judgment
we must not make in code. V0.05 resolution: **structure decides, not
semantics.** Rules, applied to the parsed markdown:

1. Split body into sentences (deterministic splitter; headings, list markers,
   and the Uncertainties section header excluded from *chip* requirements).
2. Every sentence in the report body outside the Uncertainties section must
   carry ≥1 chip. No content-based "is this factual?" classification — if the
   Synthesizer wants to say it, it cites it. Connective fluff dies in review,
   which is the correct pressure.
3. Every chip must resolve through the citationMap to ≥1 **live, approved**
   canonical claim with ≥1 **live** evidence row (raw SQL check — the §9.5
   provenance walk lands in `packages/db/src/raw/provenance.ts`).
4. Unknown chip in text, unused map entry, dead/contested-as-settled claim id,
   or a missing acceptedUncertainty ⇒ **REJECT (QUALITY_FAILURE)** with a
   human-readable DecisionRecord ("sentence 14 has no citation chip"), feeding
   the normal retry ladder (ADR-010) — retry directive includes the rejection
   detail so attempt 2 can fix it.
5. Contested claims MAY be cited, but only from sentences inside the
   Uncertainties section or sentences that carry the contest wording — V0.05
   simplification: contested claim ids are only valid chips in the
   Uncertainties section.

### D4 — Endgame rewiring: ACCEPT → synthesize task; accepted synthesis → COMPLETED

- `applyEvaluatorDecision` ACCEPT branch: same tx creates ONE `synthesize` task
  (input: fully concrete — runId-scoped, spec version, final-verdict id per
  ADR-011) and walks EVALUATING → SYNTHESIZING. No more direct COMPLETED.
- New `acceptSynthesisAttempt` in `packages/core`: pre-accept validator (D3)
  passes → accept + walk SYNTHESIZING → COMPLETED + `RUN_COMPLETED` (kind
  accept), all in one tx. The gate-kind event for the synthesis judgment point
  follows §24.3.
- Synthesize task FAILED/BLOCKED (attempts exhausted) → `synthesis_failed`
  human checkpoint + WAITING_HUMAN, mirroring the P4 `analysis_failed` path.
  Evidence and the accepted analysis survive; a human can retry synthesis.
- Fake/e2e outputs keep the P4 escape hatch (walk through without a report).

### D5 — forSynthesizer context: approved material ONLY

`forSynthesizer(runId)` (§12): latest **accepted** analysis + live canonical
claims with citation-ready evidence references (id, url, sourceClass,
vendor flag — what the report needs to cite, not full excerpts beyond K=2) +
the final ACCEPT verdict's acceptedUncertainties + spec (objective, criteria,
scope) + spec version. Never: reasoning artifacts (ADR-018), rejected
analyses, raw research notes. Budget 24k with the P4 ladder (tighten K →
claims-only); loud failure if spec/uncertainties would drop.

### D6 — Read APIs (§24.5): trace, transcript, citations

- `GET /runs/:id/attempts/:attemptId/trace` — deterministic AttemptTrace
  assembly (§24.2 block sequence: context_in, reasoning, tool_calls by seq,
  output, control). The trace assembler is the sanctioned base-table reader
  (CLAUDE.md rule 5); it lives in `packages/db` (or a thin `packages/trace`
  over db repositories — decided at implementation, whichever keeps rule 5
  clean).
- `GET /runs/:id/transcript?page=` — all traces in staged order, paginated by
  stage to bound payloads.
- `GET /runs/:id/report` + `GET /runs/:id/report/citations` — report markdown
  artifact + citation map with resolved claim/evidence targets (powers
  chip-jump).
- Existing claims/coverage endpoints already satisfy their §24.5 rows.

### D7 — Console wiring (5.4): report view + transcript reading mode

Mockup-normative (ADR-019): report tab renders markdown with chips as
interactive elements — click jumps to the claim/evidence in the Claims
browser; Uncertainties section visually distinct. Transcript reading mode:
staged, paginated, renders TraceBlocks (reasoning collapsed by default,
display-only per ADR-018). WAITING_HUMAN banner already exists; add the
`synthesis_failed` reason.

### D8 — Gate strategy: two legs, doctored-draft leg is deterministic

- **Leg A (live, ~one G-task run):** end-to-end run through synthesis;
  gate script samples a random chip-bearing sentence and walks
  sentence → chip → claim → evidence → source → attempt using **API calls
  only** (no DB access in the assertion path). Asserts: run COMPLETED, report
  artifact exists, every chip resolves, Uncertainties section reproduces the
  verdict's acceptedUncertainties.
- **Leg B (deterministic, no models):** feed the validator a doctored draft —
  real accepted run's citationMap with (a) an uncited sentence inserted, (b) a
  chip pointing at a superseded claim — assert both REJECT with rationale.
  Runs as part of the gate script against the test DB; also lives in the unit
  suite so it never regresses.

## Ticket mapping (tracker 5.1–5.4)

| Ticket | Delivers | Decisions |
|---|---|---|
| 5.1 | Schemas + forSynthesizer + agent v1 + worker handler + endgame rewiring | D1 D2 D4 D5 |
| 5.2 | Citation validator + provenance raw SQL + retry wiring | D3 |
| 5.3 | Trace assembler + trace/transcript/report/citations APIs | D6 |
| 5.4 | Console report + transcript views | D7 |
| gate | scripts/gates/p5.ts, both legs | D8 |

## Test plan

- Schemas: SynthesizerOutput parse/default cases (P4 norm).
- Context: forSynthesizer selection (accepted-only analysis, no reasoning,
  budget ladder, loud failure).
- Agents: synthesizer contract test (schema in/out, empty tool allowlist)
  with stubbed ModelClient.
- Core: validator unit matrix (uncited sentence, unknown chip, dead claim,
  contested-outside-uncertainties, missing uncertainty, happy path);
  acceptSynthesisAttempt tx behavior (accept→COMPLETED, reject→retry ladder,
  exhausted→checkpoint); ACCEPT-creates-synthesize-task.
- DB: provenance walk SQL against seeded lineage (test DB).
- API: trace/transcript/report endpoint shape tests.
- Live-model checks stay in the gate + goldens, per CLAUDE.md.
