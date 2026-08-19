# ADR-009: Local models do volume; frontier models do gates

- **Status:** Accepted (kept through v0.2.1)
- **Source:** `docs/system-design-v0.2.1.md` §15, §21

## Decision

High-volume work (research, extraction) runs on local models (vLLM on the single
GPU box); frontier models are reserved for judgment gates (planning, evaluation,
synthesis). Routing is a Control Plane/policy concern, not an agent's choice.

## Consequences

- Cost and latency budgets (§15.2–15.3) are modeled before building.
- The retry ladder can escalate tier (strong_local → frontier) as a policy step.
