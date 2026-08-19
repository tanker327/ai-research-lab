import { defineConfig } from "vitest/config";

// .claude/hooks tests use bun:test and run via `bun test ./.claude/hooks` (see
// the "check" script); vitest owns only product code.
export default defineConfig({
  test: {
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts", "scripts/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    passWithNoTests: true,
  },
});
