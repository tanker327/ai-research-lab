# Progress Tracking Policy

In-progress work is tracked in **`progress/current.json`** — the agent's working
memory for the active phase of `docs/implementation-plan.md` §6. The plan is the
roadmap; `current.json` tracks work *within* the current phase. Use JSON, not
Markdown — strict syntax resists corruption by edits.

Task ids mirror the plan's ticket numbers (`"0.3"`, `"1.2"`); `depends_on` lists
ticket ids; lower `priority` number = do first.

## Session startup

1. `git log --oneline -20` — review recent changes.
2. Read `progress/current.json` — check task status and `current_phase`.
3. Pick the `pending` task with the highest priority whose `depends_on` are all
   `completed`. Skip `completed`, `blocked`, and unmet-dependency tasks.
4. If the work touches the DB, confirm Postgres is up
   (`docker compose -f infra/docker-compose.yml up -d postgres`).
5. Set the chosen task's `status` to `in_progress` (and `started_at`), then begin.

(The SessionStart hook prints this summary automatically; confirm/adjust the
chosen task with the user before starting.)

## During work

`PLAN → BUILD → VERIFY → FIX`: read the ticket and the corresponding §5 interface
code first (CLAUDE.md), implement with tests, run the phase gate, fix failures.
Keep retries bounded per `.claude/rules/retry-policy.md`.

## On completion

1. Update the task: `status: "completed"`, `completed_at`, `commit` (hash).
2. Commit per `.claude/rules/commit-message.md`.
3. Never leave a task `in_progress` when ending a session — set it back to
   `pending` or `blocked` (with a `blockers` note) if unfinished.
4. When a phase's gate passes, archive the phase's tasks to
   `progress/archive/phase-N.json` and seed the next phase's tickets.

## Task-management rules (MUST follow)

- **Do NOT create new top-level tasks without human approval.** Discovered work
  goes in the current task's `notes` or `known_issues` in `current.json`, and is
  surfaced to the user. (No GitHub remote yet; when one exists, unrelated
  non-blocking bugs move to GitHub Issues.)
- A phase is done when its gate script passes — not when the code "looks done."
