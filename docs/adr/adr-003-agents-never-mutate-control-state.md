# ADR-003: Agents never mutate control state directly

- **Status:** Accepted (kept through v0.2.1)
- **Source:** `docs/system-design-v0.2.1.md` §2 (P2), §21

## Decision

Agents return schema-validated decisions; the Control Plane interprets them and
performs all state changes (via `assertTransition`, in transactions, with events).
No agent is asked to remember or write which task is running, retry counts, or
dependency satisfaction.

## Consequences

- The control plane is testable with zero LLM involvement (`packages/core` imports
  nothing from agent/model packages).
- An agent writing task status is an architecture violation and a PR rejection.
