# ADR-015: Merged Evaluator until transcripts justify Critic/Judge split

- **Status:** Accepted (new in v0.2)
- **Source:** `docs/system-design-v0.2.1.md` §6.5, §21, §22

## Decision

A single merged Evaluator (plus deterministic pre-checks) handles quality judgment
in V0.05. A Critic/Judge split or multi-judge/cross-model evaluation arrives only
with transcript evidence of need.

## Consequences

- Fewer frontier calls per gate; simpler retry semantics.
- Open question §22 tracks when the split trigger is met.
