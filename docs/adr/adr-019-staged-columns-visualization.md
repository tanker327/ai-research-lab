# ADR-019: Canonical task visualization is staged columns (waves)

- **Status:** Accepted (new in v0.2.1)
- **Source:** `docs/system-design-v0.2.1.md` §24.8

## Decision

The task graph renders as staged columns reflecting staged planning (ADR-011), not
a force-directed node graph. Stages *are* the semantics; a spring layout would hide
exactly the structure that matters.

## Consequences

- The console's primary view maps 1:1 to plan stages and waves.
