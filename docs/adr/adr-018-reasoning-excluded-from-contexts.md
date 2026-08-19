# ADR-018: Model reasoning persisted for observability, excluded from agent contexts

- **Status:** Accepted (new in v0.2.1)
- **Source:** `docs/system-design-v0.2.1.md` §24.8

## Decision

Model reasoning is persisted (artifact `type='reasoning'`) for display/debug only.
It is never fed into other agents' contexts and never cited — otherwise it becomes
an unaudited side channel bypassing the claim→evidence provenance chain.

## Consequences

- `packages/context` must not select `type='reasoning'` artifacts (hard rule 9).
- The citation validator can never see a reasoning artifact as a source.
