#!/usr/bin/env bun
// PreToolUse (Bash) hook: refuse shell WRITES to protected files, complementing
// block-protected.sh (which covers the Edit/Write/NotebookEdit tools).
//   - .env / .env.* hold real credentials; .env.example is exempt.
//   - bun.lock is owned by `bun install` (which never names the file → passes).
// Reads (cat/grep/source .env) stay allowed — the guarded channel is edits.
// Best-effort honest-mistake catcher, NOT a security boundary: perfect shell
// parsing is impossible; we block "names a protected file AND contains a
// write-shaped operation". Exit 2 blocks and feeds stderr back to Claude.
//
// Invoked as `bun block-protected-bash.ts` with the tool-call JSON on stdin.

import { stripLiterals } from "./command-text";

const ENV_RE = /(^|[\s"'=(:])(\.\/)?\.env(\.(?!example\b)[A-Za-z0-9_.-]+)?($|[\s"');&|])/;
const LOCK_RE = /(^|[\s"'=(:])(\.\/)?bun\.lock($|[\s"');&|])/;

export function checkCommand(raw: string): ".env" | "bun.lock" | null {
  // Strip heredoc bodies + quoted strings: a commit message mentioning
  // ".env" or "bun.lock" must not block the commit — path ARGUMENTS to
  // write commands are unquoted in practice (and a quoted path evading this
  // is outside the honest-mistake threat model).
  const cmd = stripLiterals(raw);
  const target = ENV_RE.test(cmd) ? ".env" : LOCK_RE.test(cmd) ? "bun.lock" : null;
  if (!target) return null;
  const writeShaped =
    />{1,2}/.test(cmd) || // redirection
    /\bsed\b[^|;&]*\s-[a-zA-Z]*i/.test(cmd) || // in-place sed
    /\b(tee|rm|mv|cp|truncate|unlink|shred|dd|chmod|chown|ln)\b/.test(cmd);
  return writeShaped ? target : null;
}

if (import.meta.main) {
  let target: ".env" | "bun.lock" | null = null;
  try {
    const input = JSON.parse(await Bun.stdin.text());
    target = checkCommand(input.tool_input?.command ?? "");
  } catch {
    // Malformed input: fail open — a broken hook must never wedge the session.
  }
  if (target === ".env") {
    console.error(
      "Blocked: this command looks like it writes to a .env file (gitignored, holds real DATABASE_URL/S3 credentials). Edit it manually if needed; update .env.example for shape changes. Plain reads (cat/grep/source) are allowed — drop the redirect/write operation.",
    );
    process.exit(2);
  }
  if (target === "bun.lock") {
    console.error(
      "Blocked: bun.lock is managed by Bun. Run 'bun install' / 'bun add' to change dependencies instead of writing the lockfile directly.",
    );
    process.exit(2);
  }
}
