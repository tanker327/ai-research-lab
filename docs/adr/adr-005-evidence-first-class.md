# ADR-005: Evidence is first-class

- **Status:** Accepted (kept through v0.2.1)
- **Source:** `docs/system-design-v0.2.1.md` §9, §18, §21

## Decision

Evidence rows are first-class records linking claims to sources, carrying categorical
facts (not floats). The provenance chain
`Task → Attempt → Artifact → Claim → Evidence → Evaluation → Decision` is the
system's crown jewel: every synthesized statement traces back to stored evidence.

## Consequences

- Downstream agents and the citation validator (ADR-020) operate on evidence rows,
  not on model memory.
- Deterministic pre-checks (minimum live-evidence counts, source-independence rules)
  become possible because evidence is queryable.
