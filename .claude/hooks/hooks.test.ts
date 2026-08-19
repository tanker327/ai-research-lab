// Regression tests for the Bash-guard hooks. Wired into the root `test` script
// so a weakened guard fails CI like any other regression.
import { describe, expect, test } from "bun:test";
import { checkCommand as noVerify } from "./block-no-verify";
import { checkCommand as protectedBash } from "./block-protected-bash";

describe("block-no-verify", () => {
  const blocked = [
    "git commit --no-verify -m 'x'",
    "git commit -n -m 'x'",
    "git commit -an",
    "git commit -am 'x' -n",
    "git push --no-verify",
    "git -c core.hooksPath=/dev/null commit -m 'x'",
    "cd repo && git -c core.hooksPath=/tmp/none push origin main",
  ];
  const allowed = [
    "git commit -m 'fix -n handling in parser'", // flag only inside quotes
    'git commit -m "document --no-verify blocking"',
    "git commit -am 'x'",
    "git config core.hooksPath .githooks", // the legit activation command
    "grep -n foo src/index.ts",
    "sort -n numbers.txt",
    "bun test",
    "git push origin harness/improvements",
    // compound command: -n belongs to grep's segment, not git commit's
    "grep -rn Co-Authored-By . ; git add -A && git commit -m 'x'",
    // a heredoc commit message that MENTIONS the flag must not block
    "git commit -m \"$(cat <<'EOF'\nblock --no-verify and git commit -n in the hook\nEOF\n)\"",
  ];
  for (const cmd of blocked) {
    test(`blocks: ${cmd}`, () => expect(noVerify(cmd)).not.toBeNull());
  }
  for (const cmd of allowed) {
    test(`allows: ${cmd}`, () => expect(noVerify(cmd)).toBeNull());
  }
});

describe("block-protected-bash", () => {
  const blocked: Array<[string, string]> = [
    ["echo FOO=1 >> .env", ".env"],
    ["sed -i '' 's/a/b/' .env", ".env"],
    ["rm .env.production", ".env"],
    ["cp .env.example .env", ".env"], // writes .env even though source is exempt
    ["cat secrets | tee .env", ".env"],
    ["rm bun.lock", "bun.lock"],
    ["echo '{}' > bun.lock", "bun.lock"],
  ];
  const allowed = [
    "cat .env",
    "grep DATABASE_URL .env",
    "source .env && bun run apps/service/src/index.ts",
    "cat .env.example",
    "echo FOO=1 >> .env.example",
    "bun install", // rewrites bun.lock itself but never names it
    "git checkout bun.lock", // restore from HEAD is not a stray write
    "echo hello > /tmp/out.txt",
    // a heredoc commit message that MENTIONS protected files must not block
    "git commit -m \"$(cat <<'EOF'\nnever hand-edit bun.lock or rm .env\nEOF\n)\"",
  ];
  for (const [cmd, target] of blocked) {
    test(`blocks (${target}): ${cmd}`, () => expect(protectedBash(cmd)).toBe(target));
  }
  for (const cmd of allowed) {
    test(`allows: ${cmd}`, () => expect(protectedBash(cmd)).toBeNull());
  }
});
