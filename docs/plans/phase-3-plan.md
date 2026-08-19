# Phase 3 Plan — Planner · Researcher · Extractor

**Status:** Draft for review 2026-08-19 · **Source tickets:** implementation-plan §6 Phase 3 · **Contracts:** system-design §6.1–6.3, §7, §9, §10, §12
**Thesis:** by the end of this phase, a real research question submitted from the console runs staged planning (ADR-011): a stage-1 discovery wave produces Research Note artifacts, the Extractor turns them into evidence + raw claims, canonicalization dedupes them into live canonical claims, and the Planner's stage-2 call creates fully-concrete deep tasks from what was found. First real prompts; first real agent loop.

---

## Pre-flight constraints (what Phase 2 left us)

| Constraint | Consequence here |
|---|---|
| Frontier tier dark (hub 401 — user action pending) | Planner spec'd for frontier cannot run there yet → **D3** |
| `web_search` gated on provider choice (P2-D4, still open) | Researcher pass-1 has only `web_fetch` → **D4** |
| P2 gate norm: every agent-schema array/string bounded | All Phase-3 output schemas carry `.max()` everywhere → **D1** |
| Reasoning models need `maxOutputTokens` headroom | Per-role output budgets in prompt config, not call sites |
| `json_object` (fast_local) gets schema injected into system prompt | Extractor batch-confirm works on deepseek unchanged |
| All tables already exist (Phase 0 DDL): evidence, raw_claims, canonical_claims, claim_evidence_links, research_specs, plan_stages, live_* views | No schema migration except enabling `pg_trgm` (3.5) |

## Findings during the phase (append-only)

- **Dark frontier hard-fails escalation routes (3.7 live run):** the researcher's attempt-3 `frontier` escalation hit the hub's invalid keys (401 PERMANENT_INFRA) and failed the task. D3 extended: `FRONTIER_ENABLED=0` (default while keys are pending) loudly downgrades ANY frontier-resolved route to strong_local with a `TIER_DOWNGRADED` warn event. Set to 1 when the keys land — required before P4's real escalation ladder.
- **No `z.record` in agent output schemas (3.7 live run):** vLLM guided decoding returns upstream 500 on open-keyed objects (`additionalProperties` schemas). PlannedTask.input became a CLOSED, fully-bounded nullable-field object; the interpreter builds the task's input record dropping nulls. NORM alongside the bounded-arrays rule: agent schemas contain no records/open maps.
- **Merge direction must be deterministic (3.5):** naive trigram merging ping-pongs two near-dup subjects across re-runs (each folds into the other). Rule: only merge INTO a subject that sorts lexicographically earlier — re-runs converge on one row, keeping canonical rows a pure function of the live set.
- **ai v7 forbids system-role rows in `messages` (3.2):** `AI_InvalidPromptError` at runtime — the system prompt must go through `generateText`'s separate `system` option. ModelClient already exposes it; agents pass `system: SYSTEM`, never a system message.

## Design decisions (settled before coding; D3/D4 need user input)

### D1 — Prompt v1 conventions (the "prompt contract")
Prompts live in `packages/agents/src/<role>/v1/prompt.ts` as versioned source; behavior changes after a version has produced accepted attempts = new `v2/` directory, never in-place edits (CLAUDE.md, design §33). Each prompt module exports:

- `SYSTEM: string` — role, contract, and hard rules (cite-or-drop, no invented URLs).
- `buildMessages(input) → ModelMessage[]` — pure function of the schema-validated input.
- `OUTPUT_BUDGET: number` — `maxOutputTokens` incl. reasoning headroom (P2 norm).

Schema norms (P2 gate finding, now law for every agent schema in `@lab/schemas`):
every array `.max()`, every string `.max()`, enums over free strings wherever the
value set is closed, `.min(1)` on arrays that must not be empty. Output schemas are
the *interface*; agents never see or emit control state (ADR-003).

### D2 — Context builder shape
`packages/context` implements the §12 interface subset needed now:

```ts
interface ContextBuilder {
  forPlanner(runId: string, stage: number): Promise<PlannerInput>;
  forResearcher(taskId: string): Promise<ResearcherInput>;
  forExtractor(taskId: string): Promise<ExtractorInput>;  // trivial: note artifact + sourcesVisited + question
}
```

- Reads go through `live_*` views and repositories only (rule 5); **never selects `type='reasoning'` artifacts** (ADR-018, rule 9) — enforced by a contract test that plants a reasoning artifact and asserts it is not selected.
- Built input is persisted verbatim on the attempt (R12) — already wired in dispatch (§5.5).
- **Token budgeting V0.05:** budget per role in config; estimator is `chars/4` (no tokenizer dependency — deferred-trigger table). Overflow order per §12: drop `context`-relation evidence → tighten per-claim K → summarize→ if a hard constraint (spec, success criteria, contested claims) would drop, **fail the build loudly** with `QUALITY_FAILURE` — a task-sizing bug, never hidden.
- `liveClaimDigest` (Planner) and `liveEvidenceDigest` (Researcher, same-subject only) are deterministic string renderings — code, not an LLM summarizer.

### D3 — Planner tier while the frontier is dark: **RESOLVED 2026-08-19 — strong_local + warn**
Design routes the Planner to the frontier. Hub keys are still invalid (tracked user action). Proposal: a temporary, explicit routing amendment `planner → strong_local` behind config (`PLANNER_TIER=strong_local` default until keys land), with a `kind:'warn'` event emitted on every planner attempt routed off-frontier so the downgrade is visible in the console timeline — honoring "never silently downgrade" by making it loud instead of forbidden. Revert the default to `frontier` the day keys work. *(User approved 2026-08-19.)*

### D4 — Researcher discovery: **RESOLVED 2026-08-19 — self-hosted SearXNG**
User will run a SearXNG server and share the endpoint when needed. `web_search` lands in ticket 3.3 against SearXNG's JSON API (`SEARXNG_BASE_URL` in config; tool returns title/url/snippet triples, bounded list). Contract tests run against a stubbed fetch, so 3.3 is not blocked on the deployment — but the **live** researcher golden run and `gate:p3` need the endpoint. Tracked as a user action with a deadline of Session C's golden run. Research task inputs may still carry optional Planner `seedUrls` (cheap, complements search).

### D5 — PlanDelta interpretation is Control-Plane code (ADR-003, ADR-011)
The Planner returns `PlanDelta`; `packages/core/src/plan.ts` interprets it in one transaction:
- `addTasks`: resolve `localId` → UUIDv7, map dependencies (localIds + existing UUIDs), insert tasks `CREATED` + dependency rows, then readiness-sweep them. **Concreteness guard:** reject (SCHEMA_FAILURE-equivalent `QUALITY_FAILURE`) any task whose `input` contains template-placeholder patterns (`{{`, `<insert`, `TBD`, empty required fields) — staged-planning invariant made executable (rule 12).
- `cancelTaskIds` / `supersedeTaskIds`: via `assertTransition` in-tx with events (rules 3, 8).
- Stage bookkeeping: `plan_stages` row per planner call; spec versioning per §13 (stage 1 creates spec v1; REPLAN bumps — REPLAN itself arrives in P4, only the version mechanics land now).
- Auto-create `extract` task after a research attempt is **accepted** — inside the same accept transaction (core, not agent), `input: { noteArtifactId, sourcesVisited, question }` fully concrete.

### D6 — Canonicalization is deterministic code + one cheap model call
`packages/evidence` pipeline per §10, run scheduler-side after extract-accept:
normalize (`subjectKey`/`predicateKey` lowercased, unit-stripped) → exact-key match → `pg_trgm` similarity (same subject, threshold 0.55) as *candidate filter only* → batch-confirm candidate merges with `fast_local` (bounded schema: `merge: boolean` per pair) → upsert canonical claim + relink evidence in-tx. Values disagree ⇒ `status: contested` + note. Model unavailability degrades to "no merge" (safe: duplicates survive, nothing is wrongly merged) with a `warn` event. `packages/evidence` may import `@lab/model` (it is not `core`); the *invocation* stays scheduler-side.

## Sessions and tickets

### Session A — Context builders (ticket 3.1)
`packages/context` per D2 + config token budgets. **Accept:** builder unit tests against seeded Postgres (digest rendering, subject filtering, budget overflow order, loud-failure case, ADR-018 exclusion test).

### Session B — Planner v1 (ticket 3.2)
Schemas (`PlannerInput/Output`, `PlanDelta`, `PlannedTask`, `ResearchSpecification` in `@lab/schemas`, D1-bounded); prompt v1 with clarify stage (assumptions surfaced in `clarificationsAssumed`; `humanQuestions` only for unsafe-to-infer — V0.05 records them and fails the run to `BLOCKED`-equivalent pending human answer via `human_checkpoints`); core `PlanDelta` interpreter per D5; planner task handler registered in the worker. **Accept:** contract tests (stubbed ModelClient) for both stages; interpreter tests incl. concreteness guard + cancel/supersede transitions; one golden script planner call (live, manual).

### Session C — Researcher v1 (ticket 3.3)
`ResearcherInput/Output` schemas; prompt v1 per strategy (all six `ResearchStrategy` values; discovery biased to breadth); tool loop: model tool-calls `web_fetch` (registry enforces allowlist; every fetch snapshots — Phase 2 machinery); Research Note artifact (markdown, light template) saved via artifact store; `sourcesVisited` assembled **from the tool layer's log** (`tool_calls` rows), never model memory. **Accept:** contract tests with stubbed model+fetch (note persisted, sourcesVisited mechanical, tool-loop cap enforced by code (ADR-016 — max tool calls per attempt from config)); golden live run.

### Session D — Extractor v1 + canonicalization (tickets 3.4, 3.5)
Extractor: schemas per §6.3 (D1-bounded), prompt v1, runs on `fast_local` via router (json_object + schema injection — P2 machinery); auto-created by extract-task rule (D5, in core). Then `packages/evidence` per D6 (+ migration enabling `pg_trgm` + trigram index on `canonical_claims (subject_key, predicate_key)`). **Accept:** extractor contract tests; canonicalization tests on real Postgres — exact dup, trigram near-dup, contested values, merge-confirm stub, idempotent re-run.

### Session E — Deterministic checks + console + gate (tickets 3.6, 3.7)
Checks in `packages/core/src/checks/` (pure, DB-fed): min-live-evidence per research task (default 3), ≥1 non-vendor source for vendor-product questions, self-assessment `complete=false` + high-severity gaps ⇒ reject. Run in evaluation sweep before auto-accept; failures write DecisionRecords with verbatim-displayable rationale (§24.3) and feed `decideRetry` (rule 10 — checks decide *whether*, the ladder decides *what next*).
Console (standing UI rule): **Evidence tab live** — canonical claims grouped by subject with status chips (contested highlighted) + per-claim evidence list from `live_claim_evidence`; **New-run becomes real** — free-text question → creates a run with a stage-1 `plan` task (demo chain moves behind a toggle); timeline shows plan-stage and check events.
**Gate — `scripts/gates/p3.ts` (live models, spends budget):** submit a real question → stage-1 discovery runs → extraction → **stage-2 tasks exist with fully concrete inputs** (assert: no placeholder patterns, every deep task names its subject) → deep wave completes → canonical claims deduplicated (assert: no duplicate `(run, subject_key, predicate_key)` rows among live claims) → evidence tab read API serves claims+links.

## Out of scope
Analyst/Evaluator/autonomous loop, REPLAN + tier escalation, budget enforcement (P4) · `web_search` until D4 resolves · semantic claim matching/embeddings (V0.1 trigger) · Synthesizer/citations (P5) · Contradiction entity (V0.1).

## Definition of done
Tickets 3.1–3.7 merged with tests; `bun run gate:p3` green twice; `bun run check` green; tracker updated; frontier-pending + D4 status re-surfaced. **Audit (standing rule): every changed module has direct tests; docs greped for invalidated statements (implementation-plan §4/§5, design §6/§7/§10/§12 deltas, CLAUDE.md commands, .env.example) and synced in the same commits.**
