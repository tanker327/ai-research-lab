# CLAUDE.md — AI Research Lab

Instructions for coding agents working in this repository. Read this fully before your first edit in any session.

## What this project is

A long-running, stateful multi-agent research system. A deterministic **Control Plane** (TypeScript) manages tasks, state, retries, dependencies, budgets, and events; LLM **Agents** are invoked only at judgment points (plan, research, extract, analyze, evaluate, synthesize). PostgreSQL is the single source of truth. The thesis, which every change must respect:

> **Code manages the process. Agents make intelligent decisions. The database stores truth.**

## Read before touching code

Authority order when documents disagree (higher wins):

1. `docs/database-schema.md` — the DDL is normative; Drizzle schema must match it exactly
2. `docs/implementation-plan.md` — stack decisions (§2, locked), core interfaces (§5, implement as written), tickets (§6)
3. `docs/system-design-v0.2.1.md` — architecture, agent contracts, ADR rationale
4. `docs/adr/` — one file per ADR; cite the ADR number in commit messages when a change touches one

If a ticket seems to require deviating from these, **stop and flag it** — do not silently improvise architecture. Update the doc in the same PR as the code, or don't make the change.

## Hard rules (violations are PR rejections, not style nits)

1. **`packages/core` imports nothing from `packages/agents`, `packages/model`, or `packages/tools`.** The control plane must be testable with zero LLM involvement. The import-lint script enforces this; do not weaken it.
2. **All agent I/O contracts live only in `packages/schemas`** (Zod). API, worker, and web import from there. Never redeclare a shape locally.
3. **Never update a task/attempt/run status without `assertTransition`** inside the same DB transaction. No raw status writes anywhere else.
4. **Hot control-plane queries are raw SQL** in `packages/db/src/raw/` (claim, stale sweep, readiness sweep, supersede, coverage, provenance). Do not rewrite them in the ORM "for consistency."
5. **Every side-effect row carries `attempt_id`** (evidence, raw_claims, artifacts, tool_calls, model_calls). Downstream reads go through `live_*` views only. Reading base tables outside `packages/db` repositories and the trace assembler is a reject.
6. **Agents never mutate control state.** They return schema-validated decisions; the Control Plane interprets them. An agent that writes task status is an architecture violation (ADR-003).
7. **Every control-relevant LLM output is Zod-validated before use.** Parse failure = `SCHEMA_FAILURE` = attempt failure. Never "best effort" a malformed output.
8. **Every state change emits an event** (with `kind`: info/accept/gate/warn/fail) in the same transaction as the change.
9. **Reasoning artifacts are never fed into agent contexts** and never cited (ADR-018). `packages/context` must not select `type='reasoning'` artifacts.
10. **Retry policy decides retries** — deterministic checks and the Evaluator decide *whether* an output is rejected; `decideRetry` in `packages/core/src/retry.ts` decides *what happens next*. Never inline retry logic elsewhere. Every verdict writes a `DecisionRecord` with human-readable `rationale`.
11. **The deterministic cycle guard is code, not prompt** (ADR-016). Never rely on an LLM to stop a loop.
12. **Staged planning invariant (ADR-011):** a task row's `input` is fully concrete at creation. If you find yourself writing template placeholders into task input, the design is being violated — stop.

## Do NOT add (without a deferred-trigger being met — see implementation-plan §10)

- Queues (BullMQ/pg-boss), agent frameworks (LangGraph/Mastra/CrewAI), Temporal, vector DBs, Redis, new UI frameworks, or any dependency not already in §2 of the implementation plan. If you think one is needed, write the justification against the trigger table first.

## Conventions

- **Runtime:** Bun everywhere. TypeScript strict. No `any` in `packages/core` or `packages/schemas`.
- **Formatter/linter:** Biome (`biome.json`; `bun run lint` / `bun run format`). A PostToolUse hook auto-formats agent edits.
- **IDs:** UUIDv7 via the shared helper in `packages/schemas` — never `crypto.randomUUID()` directly.
- **Errors:** typed `CategorizedError` with the taxonomy from `packages/schemas` (TRANSIENT_INFRA, SCHEMA_FAILURE, QUALITY_FAILURE, …). No bare `throw new Error`.
- **Logging:** pino child loggers scoped `{ runId, taskId, attemptId }`. No `console.log` outside scripts.
- **Prompts:** live in `packages/agents/src/<role>/v1/prompt.ts` as versioned source. Changing a prompt's behavior = new version directory (`v2/`), never in-place edits after a version has produced accepted attempts (design §33).
- **Migrations:** additive files via drizzle-kit; views and CHECK constraints as raw SQL steps. Never edit an applied migration.

## Testing rules

- Tests run against **real Postgres** (docker compose). Mocked-DB tests of control-plane logic are worthless — the correctness *is* SQL semantics (SKIP LOCKED, partial unique indexes, transactional supersede).
- Failure-injection fixtures (implementation-plan §8) are the Phase 1/4 test suite. When you fix a concurrency bug, add its injection to the matrix.
- Phase gates are scripts in `scripts/gates/` — a phase is done when its gate passes in CI, not when the code "looks done."
- Agent code (`packages/agents`) gets contract tests (schema in/out, allowlist enforcement) with stubbed ModelClient. Live-model tests live in `scripts/golden/` and are run manually.

## Commands

```bash
bun install
docker compose -f infra/docker-compose.yml up -d postgres
bun run migrate            # drizzle-kit migrate
bun run dev:api            # Hono API + scheduler
bun run dev:worker         # one worker (run twice for two)
bun run dev:web            # console UI (Vite dev server on :5173, proxies /api → :8787)
bun run test               # vitest, requires postgres up
bun run check              # biome lint + import-lint + typecheck + tests (run before commit)
bun run gate:p1            # phase gate scripts
bun run golden G2          # golden research task (live models, spends budget)
```

## Working style

- Work ticket-by-ticket from implementation-plan §6. One ticket = one PR-sized change with its tests.
- Before implementing anything in `packages/core`, read the corresponding §5 code in the implementation plan — implement *that*, including error types and event emissions shown.
- When a design question is genuinely open (marked in system-design §22 Open Questions), pick the simplest option, note it in the PR description, and add a `// OPEN-QUESTION(§22.x):` comment at the site.
- Commit messages: `P<phase>.<ticket>: <what> (ADR-xxx if touched)`.
