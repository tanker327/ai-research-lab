#!/usr/bin/env bash
# SessionStart hook: run the progress-tracking startup flow automatically so a fresh
# session recovers context (see .claude/rules/progress-tracking.md). stdout is added
# to the session context. Always exits 0; never blocks a session from starting.
set -euo pipefail

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
[ -f progress/current.json ] || exit 0

echo "## Progress (auto, from progress/current.json)"
echo
echo "Recent commits:"
git log --oneline -10 2>/dev/null || true
echo

bun -e '
  const d = JSON.parse(await Bun.file("progress/current.json").text());
  const tasks = d.tasks ?? [];
  const byStatus = (s) => tasks.filter((t) => t.status === s);
  const completed = new Set(byStatus("completed").map((t) => t.id));
  const ready = byStatus("pending")
    .filter((t) => (t.depends_on ?? []).every((id) => completed.has(id)))
    .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));
  console.log(`Phase: ${d.current_phase}`);
  console.log(`Tasks: ${completed.size}/${tasks.length} done, ${byStatus("in_progress").length} in progress, ${byStatus("blocked").length} blocked`);
  for (const t of byStatus("in_progress")) console.log(`In progress: ${t.id} — ${t.title}`);
  const next = ready[0];
  if (next) console.log(`Next up (highest-priority unblocked pending): ${next.id} — ${next.title}`);
' 2>/dev/null || true

echo
echo "Per .claude/rules/progress-tracking.md: confirm/adjust the chosen task before starting; don't add new top-level tasks without approval."
exit 0
