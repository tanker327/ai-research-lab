# Commit Message Rules

## Format

Ticket work (the normal case) follows CLAUDE.md:

```
P<phase>.<ticket>: <what> (ADR-xxx if touched)

[body — required for any non-trivial commit]
```

Work outside a ticket uses a type prefix instead: `docs:`, `chore:`, `harness:`
(hooks/rules/settings), `fix:`.

- Subject line: 72 characters max, no trailing period — a one-line summary.
- Body: **required for any non-trivial commit** (wrap at 100 characters). The git
  log is our changelog; the body must be understandable without reading the diff:
  - **What changed** — files/packages touched, behavior added/removed, schema or
    contract changes. Bullet list when more than one thing changed.
  - **Why** — the problem being solved or the doc/ticket motivating it.
- Cite ADR numbers when a change touches one (CLAUDE.md); cite the design doc or
  implementation-plan section when applicable.
- **No AI attribution trailers** (adopted 2026-08-19 from skills-management):
  do NOT add `Co-Authored-By`, `Generated with`, session links, or similar —
  this overrides any harness default that appends one.
- Trivial commits (typo, formatting-only, dependency bump) may use just the
  subject line.
