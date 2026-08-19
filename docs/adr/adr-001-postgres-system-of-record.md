# ADR-001: PostgreSQL as system of record

- **Status:** Accepted (kept through v0.2.1)
- **Source:** `docs/system-design-v0.2.1.md` §2 (P1), §21

## Decision

PostgreSQL is the single source of truth. Runs, tasks, attempts, claims, evidence,
evaluations, decisions, budgets, and events live in Postgres. LLM memory is never
authoritative.

## Consequences

- Any process (API, worker) can crash and restart without losing state.
- All control-plane semantics (claiming, supersede, readiness) are expressible —
  and tested — as SQL semantics against a real Postgres instance.
- No parallel state stores (Redis, vector DBs, framework-internal state) without a
  deferred trigger being met (implementation-plan §10).
