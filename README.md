# AI Research Lab

A long-running, stateful multi-agent research system. A deterministic **control plane** (TypeScript) manages tasks, state, retries, dependencies, and budgets; **LLM agents** are invoked only at judgment points (plan, research, extract, analyze, evaluate, synthesize); **PostgreSQL** is the single source of truth.

> **Code manages the process. Agents make intelligent decisions. The database stores truth.**

## Why this exists

Most agent frameworks put an LLM in charge of the loop and hope it terminates. This project inverts that: orchestration is plain code and SQL — crash-safe claiming (`FOR UPDATE SKIP LOCKED`), typed state machines, a deterministic retry ladder, cycle guards — and models are called only where judgment is genuinely needed. Every model call, tool call, and piece of evidence is owned by an `attempt_id`, so failed or superseded attempts' side effects go dark automatically through `live_*` views instead of poisoning downstream work.

Key properties:

- **Crash-safe by construction** — the Phase 1 gate SIGKILLs workers mid-task and asserts the system recovers with a valid event history. Stale claims are swept back into the evaluation ladder, never blindly re-queued.
- **Deterministic control, validated judgment** — agents return Zod-validated decisions; the control plane interprets them. An agent can never mutate task status (ADR-003). Malformed output is a categorized failure, never "best effort" parsed.
- **Full provenance** — every state change emits an event in the same transaction; every retry writes a human-readable `DecisionRecord`; reasoning traces are persisted as artifacts but never fed back into contexts (ADR-018).
- **Provider-independent model gateway** — tiers (`frontier` / `strong_local` / `fast_local`) bind to gateway aliases with per-provider structured-output strategies (native `json_schema` vs. schema-injected `json_object`), client-side concurrency caps, and per-call cost accounting.

## Architecture

```
apps/
  api      Hono API + scheduler (readiness/stale/evaluation sweeps, SSE event stream)
  worker   claim → dispatch → finish loop (run N of them; SKIP LOCKED makes it safe)
  web      Console UI (Vite + React) — runs, task board, live timeline, attempt inspector
packages/
  schemas  All I/O contracts (Zod) — the only place shapes are declared
  core     Control plane: state machines, retry policy, sweeps, guards (zero LLM imports)
  db       Drizzle schema + raw SQL hot paths (claim, sweeps, supersede, liveness)
  model    ModelClient → ai-hub gateway: routing, tiers, cost, reasoning capture
  tools    Allowlisted tool registry (web_fetch → content-addressed snapshots)
  context  (Phase 3) context builders
  agents   (Phase 3) versioned prompts + roles
  evidence (Phase 3) claim canonicalization
```

Design docs are first-class: [`docs/system-design-v0.2.1.md`](docs/system-design-v0.2.1.md) (architecture), [`docs/database-schema.md`](docs/database-schema.md) (normative DDL), [`docs/implementation-plan.md`](docs/implementation-plan.md) (phased tickets), and 20 [ADRs](docs/adr/) recording every load-bearing decision.

## Status

| Phase | Scope | Status |
|---|---|---|
| 0 | Repo, DB schema, migrations, fixtures | ✅ done |
| 1 | Task engine: claim, sweeps, liveness, run coordinator — zero LLM | ✅ gate green (SIGKILL torture test) |
| 2 | Model gateway, router policy, artifact store, tool registry, console inspector | ✅ gate green (live models) |
| 3 | Planner · Researcher · Extractor agents, evidence canonicalization | ⏳ next |
| 4 | Evaluator, tier escalation, budget enforcement | — |
| 5 | Synthesizer, citation-gated reports, transcript view | — |

Each phase ends with a **gate script** (`scripts/gates/`) that must pass in CI-like conditions — a phase is done when its gate passes, not when the code looks done. The console (`apps/web`) is built incrementally: every phase wires its new capabilities into the UI.

## Running it

Requires [Bun](https://bun.sh), Docker, and (for model calls) an [OpenAI-compatible gateway](docs/plans/phase-2-plan.md) — see `.env.example`.

```bash
bun install
docker compose -f infra/docker-compose.yml up -d postgres
bun run migrate
bun run dev:api      # API + scheduler on :8787
bun run dev:worker   # a worker (run it twice for two)
bun run dev:web      # console on :5173

bun run check        # lint + import-lint + typecheck + tests (real Postgres, no mocks)
bun run gate:p1      # phase 1 gate — worker SIGKILL torture test
bun run gate:p2      # phase 2 gate — live structured calls + tool persistence
```

Tests run against **real Postgres** — the correctness of the control plane *is* SQL semantics (SKIP LOCKED, partial unique indexes, transactional supersede), so mocked-DB tests would be worthless.

## Ground rules

The invariants that keep the system honest live in [`CLAUDE.md`](CLAUDE.md) — core imports no LLM code, all status writes go through `assertTransition`, every side-effect row carries `attempt_id`, retries are decided in exactly one place, and agents never touch control state. Violations are rejects, not style nits.
