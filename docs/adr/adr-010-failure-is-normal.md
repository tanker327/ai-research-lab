# ADR-010: Failure and retries are normal workflow states

- **Status:** Accepted (kept through v0.2.1)
- **Source:** `docs/system-design-v0.2.1.md` §2 (P5), §14, §21

## Decision

Retry, restrategize, remodel, block, replan, escalate, accept-partial, stop are all
ordinary state transitions. Errors are typed (`CategorizedError` taxonomy); infra
retry and intelligence retry are separate axes with separate budgets. `decideRetry`
in `packages/core/src/retry.ts` is the only place retry shape is decided.

## Consequences

- Every verdict writes a `DecisionRecord` with human-readable rationale.
- Failure-injection fixtures are the core test suite, not an afterthought.
