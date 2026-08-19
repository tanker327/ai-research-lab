#!/usr/bin/env bun
// PreToolUse (Bash) hook: block commands that bypass the pre-commit / CI gate.
// Our commit-message and retry-policy rules forbid it in writing — this enforces
// it mechanically. Exit 2 blocks the command and feeds stderr to Claude.
//
// Blocked patterns (checked with quoted strings stripped, so a commit MESSAGE
// that merely mentions a flag doesn't false-positive):
//   1. `--no-verify` anywhere (git commit/push and anything else that honors it)
//   2. `git commit -n` / combined short flags containing `n` (-n is the short
//      form of --no-verify on commit; no other common commit short flag has `n`)
//   3. `core.hooksPath` overrides combined with a commit/push in the same
//      command (git -c core.hooksPath=/dev/null commit). The legit activation
//      `git config core.hooksPath .githooks` has no commit/push → allowed.
//
// Invoked as `bun block-no-verify.ts` with the tool-call JSON on stdin.

import { stripLiterals } from "./command-text";

export function checkCommand(raw: string): string | null {
  // Strip heredoc bodies + quoted segments so flags inside commit messages
  // ("fix -n handling") are not matched. Real flags are never quoted.
  const cmd = stripLiterals(raw);
  if (/(^|\s)--no-verify(\s|=|$)/.test(cmd)) {
    return "--no-verify bypasses the pre-commit/CI gate.";
  }
  // The -n / hooksPath checks are scoped to the git-invocation SEGMENT so a
  // compound command like `grep -rn foo; git commit -m x` doesn't false-positive.
  for (const seg of cmd.split(/[|;&]+/)) {
    const isCommit = /\bgit\b.*\bcommit\b/.test(seg);
    const isPush = /\bgit\b.*\bpush\b/.test(seg);
    if (isCommit && /(^|\s)-[a-zA-Z]*n[a-zA-Z]*(\s|$)/.test(seg)) {
      return "git commit -n (short for --no-verify) bypasses the pre-commit/CI gate. Spell out long-form flags if you meant a different option.";
    }
    if ((isCommit || isPush) && seg.includes("core.hooksPath")) {
      return "overriding core.hooksPath on a commit/push bypasses the pre-commit gate.";
    }
  }
  return null;
}

if (import.meta.main) {
  let reason: string | null = null;
  try {
    const input = JSON.parse(await Bun.stdin.text());
    reason = checkCommand(input.tool_input?.command ?? "");
  } catch {
    // Malformed input: fail open — a broken hook must never wedge the session.
  }
  if (reason) {
    console.error(
      `Blocked: ${reason} Fix the reported issues instead (see .claude/rules/commit-message.md and .claude/rules/retry-policy.md).`,
    );
    process.exit(2);
  }
}
