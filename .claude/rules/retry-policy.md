# Retry and Loop Bounding Policy

Bound retries so failures get diagnosed instead of masked. The gate here is:
`bun run lint` → `bun run typecheck` → `bun test` (vitest, real Postgres) →
phase gate script (`bun run gate:pN`).

## Test/gate retries
- Maximum 2 retries for a flaky-looking failure before investigating root cause.
- If the same test fails 3 times, stop retrying and diagnose.
- A typecheck or import-lint (core isolation) failure is **never** flaky — never
  retry it; fix the cause.
- Concurrency tests against real Postgres may be timing-sensitive; if one flakes,
  that is a finding, not noise — the failure-injection matrix exists to make
  these deterministic. Add the injection rather than rerunning until green.

## Agent self-repair loops
- If a fix attempt fails twice in a row with the same error, stop and report.
- Do not blindly retry the same approach — diagnose why it failed.
- After 3 consecutive failed tool calls, pause and reassess strategy.

## Test-fix cycles
- If a test fix introduces a new test failure, revert and rethink.
- Do not chain more than 3 fix attempts without running the full suite.
- Before retrying an integration failure, confirm Postgres is up
  (`docker compose -f infra/docker-compose.yml up -d postgres`) — a down service
  is an environment issue, not a flaky test.

## When to escalate to the user
- An error you don't understand after reading source and docs.
- Circular dependency between fixes.
- Environment issue (missing tool, permission, network, Postgres down).
- A fix would require violating a CLAUDE.md hard rule or an ADR — stop and flag
  it (update the doc in the same PR, or don't make the change).
- A fix would require jumping ahead of the current implementation-plan phase.
