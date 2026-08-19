# ADR-002: Task and Attempt are separate entities

- **Status:** Accepted (kept through v0.2.1)
- **Source:** `docs/system-design-v0.2.1.md` §8.4, §21

## Decision

A Task describes *what* should be done (fully concrete input, dependencies, status).
An Attempt is one execution of that task. Tasks may have many attempts; retries,
escalations, and supersession are modeled as new attempt rows, never as mutation of
task history.

## Consequences

- Retry ladders, tier escalation, and strategy switches are queryable rows.
- Side effects attach to attempts (ADR-014), making retries safe by construction.
- The trace of "what happened" is assemblable from stored records alone.
