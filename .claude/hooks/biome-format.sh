#!/usr/bin/env bash
# PostToolUse hook: auto-format the file Claude just edited with Biome,
# so every change lands CI-clean (matches `bun run lint`/`format`).
# Reads the tool-call JSON from stdin; never blocks (always exits 0).
set -euo pipefail

input=$(cat)
file=$(printf '%s' "$input" | bun -e 'try { const d = JSON.parse(await Bun.stdin.text()); process.stdout.write(d.tool_input?.file_path ?? "") } catch { process.stdout.write("") }')

[ -n "$file" ] || exit 0
[ -f "$file" ] || exit 0

# Only formats languages Biome handles.
case "$file" in
  *.ts | *.tsx | *.js | *.jsx | *.mjs | *.cjs | *.json | *.jsonc) ;;
  *) exit 0 ;;
esac

# Mirror biome.json's ignore list — don't touch generated/build output.
case "$file" in
  */dist/* | */generated/* | *.tsbuildinfo | *bun.lock) exit 0 ;;
esac

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
BIOME=./node_modules/.bin/biome
[ -x "$BIOME" ] || exit 0

# Auto-format + apply safe fixes.
"$BIOME" check --write "$file" >/dev/null 2>&1 || true

# Surface anything --write couldn't fix (lint errors needing code changes) back to
# Claude as additionalContext. biome exits non-zero only when violations remain.
if ! out=$("$BIOME" check "$file" 2>&1); then
  printf '%s' "$out" | bun -e 'const t = await Bun.stdin.text(); process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "Biome still reports issues after auto-format (fix in code):\n" + t } }))' 2>/dev/null || true
fi
exit 0
