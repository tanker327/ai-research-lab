# Architecture Decision Records

One file per ADR. Bodies are extracted from `docs/system-design-v0.2.1.md` (§21, §24.8),
which remains the authoritative narrative; each ADR cites its source sections.
Cite the ADR number in commit messages when a change touches one (see CLAUDE.md).

| ADR | Title | Status |
|---|---|---|
| [001](adr-001-postgres-system-of-record.md) | PostgreSQL as system of record | kept |
| [002](adr-002-task-attempt-separate.md) | Task and Attempt are separate entities | kept |
| [003](adr-003-agents-never-mutate-control-state.md) | Agents never mutate control state directly | kept |
| [004](adr-004-structured-outputs-for-control.md) | Structured outputs required for control decisions | kept |
| [005](adr-005-evidence-first-class.md) | Evidence is first-class | kept |
| [006](adr-006-artifacts-not-chat.md) | Agent communication via artifacts, not chat | kept |
| [007](adr-007-provider-independent-gateway.md) | Model gateway is provider-independent (via ai-hub) | amended |
| [008](adr-008-build-orchestration-first.md) | Build orchestration runtime before agent frameworks | kept |
| [009](adr-009-local-volume-frontier-gates.md) | Local models do volume; frontier models do gates | kept |
| [010](adr-010-failure-is-normal.md) | Failure and retries are normal workflow states | kept |
| [011](adr-011-staged-planning.md) | Staged planning: tasks created only when inputs are concrete | new in v0.2 |
| [012](adr-012-two-pass-research.md) | Two-pass research: free-form note, then guided extraction | new in v0.2 |
| [013](adr-013-evidence-stores-facts.md) | Evidence stores facts; judgments happen at evaluation time | new in v0.2 |
| [014](adr-014-attempt-owned-side-effects.md) | Side effects are attempt-owned; only accepted attempts are live | new in v0.2 |
| [015](adr-015-merged-evaluator.md) | Merged Evaluator until transcripts justify Critic/Judge split | new in v0.2 |
| [016](adr-016-deterministic-cycle-guard.md) | Deterministic cycle guard caps autonomous loops | new in v0.2 |
| [017](adr-017-ui-pure-projection.md) | The UI is a pure projection of stored records | new in v0.2.1 |
| [018](adr-018-reasoning-excluded-from-contexts.md) | Model reasoning persisted for observability, excluded from agent contexts | new in v0.2.1 |
| [019](adr-019-staged-columns-visualization.md) | Canonical task visualization is staged columns (waves) | new in v0.2.1 |
| [020](adr-020-citation-validator-gates-synthesis.md) | Deterministic citation validator gates synthesis | new in v0.2.1 |
