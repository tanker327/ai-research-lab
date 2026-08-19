# ADR-013: Evidence stores facts; judgments happen at evaluation time

- **Status:** Accepted (new in v0.2)
- **Source:** `docs/system-design-v0.2.1.md` §9, §21

## Decision

Evidence rows store categorical facts (source type, affiliation, date, support
relation), not confidence floats or verdicts. Judgment is applied at evaluation
time by the Evaluator plus deterministic coverage checks over the live evidence set.

## Consequences

- Facts remain reusable when evaluation policy changes; no baked-in scores to migrate.
- Coverage computation is deterministic SQL over live rows, not model opinion.
