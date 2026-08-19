# ADR-008: Build orchestration runtime before agent frameworks

- **Status:** Accepted (kept through v0.2.1)
- **Source:** `docs/system-design-v0.2.1.md` §21; implementation-plan §2 (locked)

## Decision

The orchestration runtime is built in-house (`packages/core`, ~1.5k LOC deterministic
TypeScript). LangGraph/Mastra/CrewAI/AutoGen, Inngest/Trigger.dev are rejected;
Temporal is deferred, not rejected (implementation-plan §10).

## Consequences

- Frameworks own state/retry semantics that would conflict with Run/Task/Attempt and
  liveness as queryable Postgres rows.
- Adding any orchestration dependency requires the deferred-trigger justification first.
