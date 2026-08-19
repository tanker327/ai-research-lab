---
description: Scaffold a new ADR with the next number
argument-hint: <decision title>
allowed-tools: Bash(ls:*), Bash(date:*), Read, Write, Edit
---

Create a new Architecture Decision Record for: **$ARGUMENTS**

Follow the existing files in `docs/adr/`:

1. List `docs/adr/` to find the highest existing `adr-NNN-*.md`; the new number
   is that + 1 (zero-padded to 3 digits).
2. Create `docs/adr/adr-<NNN>-<kebab-title>.md` matching the existing format:
   title `ADR-<NNN>: $ARGUMENTS`, then **Status** (start as `Proposed
   (<today's date>)`; I'll move it to Accepted once we agree), **Source**
   (the design doc / implementation-plan section motivating it, if any), then
   `## Decision` and `## Consequences` (include at least one negative
   consequence, and name the enforcement mechanism — lint rule, CHECK
   constraint, test, or review rule).
3. If this decision supersedes an existing ADR, note `Supersedes: ADR-XXX` and
   change only the old ADR's Status line to `Superseded by ADR-<NNN>` — never
   edit its body.
4. Add a row to the index table in `docs/adr/README.md`.
5. If the decision adds or changes a hard rule, update CLAUDE.md's hard-rules
   section in the same change.

Keep it to one page, narrative. Ask me for any context you're unsure about
rather than guessing.
