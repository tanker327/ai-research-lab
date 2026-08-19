# ADR-006: Agent communication via artifacts, not chat

- **Status:** Accepted (kept through v0.2.1)
- **Source:** `docs/system-design-v0.2.1.md` §2 (P3), §21

## Decision

Agents communicate through artifacts and structured records
(`Task → Attempt → Artifact → Claim → Evidence → Evaluation → Decision`), never
through remembered conversation. Artifacts are immutable and content-addressed (sha256).

## Consequences

- Any agent's input is reconstructable by the Context Builder from stored rows.
- No hidden chat-history side channels; traces survive process restarts.
