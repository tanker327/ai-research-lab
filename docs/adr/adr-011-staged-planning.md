# ADR-011: Staged planning — tasks created only when inputs are concrete

- **Status:** Accepted (new in v0.2)
- **Source:** `docs/system-design-v0.2.1.md` §7, §21

## Decision

A task is only created when its input can be fully concrete. Planning happens in
stages: a cheap discovery wave produces live claims; the Planner then reads results
and writes fully parameterized deep tasks. The DAG grows in waves and is a DAG at
all times, just not fully known at T0.

## Consequences

- No input-templating machinery ("for each candidate in {T100.output}…") exists.
- Writing template placeholders into task input is a design violation — stop.
- `RESEARCH_MORE` follow-ups are created deterministically from `requiredActions`;
  `REPLAN` yields a `PlanDelta` (supersede, never overwrite history).
