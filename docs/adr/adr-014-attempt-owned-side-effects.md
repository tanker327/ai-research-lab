# ADR-014: Side effects are attempt-owned; only accepted attempts are live

- **Status:** Accepted (new in v0.2)
- **Source:** `docs/system-design-v0.2.1.md` §11, §21

## Decision

Every side-effect row (evidence, raw claims, artifacts, tool/model calls) carries its
`attempt_id`. Rows are live only when their attempt is ACCEPTED. Accepting a retry
supersedes prior attempts atomically in one transaction — their side effects go dark
without deletion. Downstream reads go through `live_*` views only.

## Consequences

- A crashed or rejected attempt can never corrupt what downstream agents see.
- Retries are safe by construction, not by cleanup code.
- Reading base tables outside `packages/db` repositories and the trace assembler is
  a PR rejection.
