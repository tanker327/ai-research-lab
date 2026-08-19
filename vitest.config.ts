import { defineConfig } from "vitest/config";

// .claude/hooks tests use bun:test and run via `bun test ./.claude/hooks` (see
// the "check" script); vitest owns only product code.
export default defineConfig({
  test: {
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts", "scripts/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    passWithNoTests: true,
    // DB tests share one real Postgres; global claim/sweep queries would see
    // each other's rows across concurrently running files. Concurrency inside
    // a test (worker races) is explicit, never an accident of the runner.
    fileParallelism: false,
  },
});
