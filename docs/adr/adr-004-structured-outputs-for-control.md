# ADR-004: Structured outputs required for control decisions

- **Status:** Accepted (kept through v0.2.1)
- **Source:** `docs/system-design-v0.2.1.md` §2 (P4), §21

## Decision

Every control-relevant LLM output is Zod-validated (schemas live only in
`packages/schemas`) before use. Free-form prose is stored as an artifact but never
drives control flow directly. Parse failure = `SCHEMA_FAILURE` = attempt failure —
never "best effort" a malformed output.

## Consequences

- One schema source shared by API, worker, and web.
- Guided decoding (ADR-012 / vLLM `json_schema`) makes schema failure near-impossible
  on the extraction path rather than a retry category.
