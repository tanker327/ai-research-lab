# ADR-020: Deterministic citation validator gates synthesis

- **Status:** Accepted (new in v0.2.1)
- **Source:** `docs/system-design-v0.2.1.md` §24.8

## Decision

A deterministic (code, not model) citation validator gates every synthesis attempt:
uncited factual sentences reject the attempt. Citations must resolve to live claims
backed by live evidence.

## Consequences

- The final report cannot contain unprovenanced statements by construction.
- Rejection feeds the normal retry ladder (ADR-010), not a special path.
