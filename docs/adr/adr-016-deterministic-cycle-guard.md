# ADR-016: Deterministic cycle guard caps autonomous loops

- **Status:** Accepted (new in v0.2)
- **Source:** `docs/system-design-v0.2.1.md` §20, §21

## Decision

The autonomous loop is capped by a deterministic guard in code (stage counts,
follow-up depth, budget), never by prompting an LLM to stop. Budget breach yields a
human checkpoint, not a silent stop.

## Consequences

- Runaway loops hard-stop regardless of model behavior.
- Never rely on an LLM to terminate a loop (CLAUDE.md hard rule 11).
