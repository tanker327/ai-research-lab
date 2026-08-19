#!/usr/bin/env bash
# PreToolUse hook: refuse edits to secret/generated files.
#   - .env / .env.* hold real credentials (DATABASE_URL, S3_* keys) and are
#     gitignored; .env.example is the only one that may be edited.
#   - bun.lock is owned by `bun install`, never hand-edited.
# Exit 2 blocks the tool call and feeds stderr back to Claude.
set -euo pipefail

input=$(cat)
file=$(printf '%s' "$input" | bun -e 'try { const d = JSON.parse(await Bun.stdin.text()); process.stdout.write(d.tool_input?.file_path ?? "") } catch { process.stdout.write("") }')

[ -n "$file" ] || exit 0
base=$(basename "$file")

case "$base" in
  .env.example)
    exit 0
    ;;
  .env | .env.*)
    echo "Blocked: '$file' is a secret env file (gitignored, holds real DATABASE_URL/S3 credentials). Edit it manually if needed; update .env.example for shape changes." >&2
    exit 2
    ;;
  bun.lock)
    echo "Blocked: bun.lock is managed by Bun. Run 'bun install' / 'bun add' to change dependencies instead of editing the lockfile." >&2
    exit 2
    ;;
esac
exit 0
