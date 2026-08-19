# ADR-012: Two-pass research — free-form note, then guided extraction

- **Status:** Accepted (new in v0.2)
- **Source:** `docs/system-design-v0.2.1.md` §6.2–6.3, §21; implementation-plan §2

## Decision

Research runs in two passes: the Researcher writes a free-form note (no JSON burden);
the Extractor converts it to structured claims/evidence using vLLM guided decoding
(`response_format: json_schema`), making schema failure near-impossible.

## Consequences

- Applies P8: "did it run", "is it right", "is it parseable" are independent axes.
- `SCHEMA_FAILURE` on extraction ⇒ re-extract only (cheap), never re-research.
