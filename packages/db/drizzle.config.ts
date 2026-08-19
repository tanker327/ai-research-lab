import { defineConfig } from "drizzle-kit";

// Paths are relative to the repo root — run via `bun run migrate` (root script).
export default defineConfig({
  dialect: "postgresql",
  // Concrete files, not the folder: the folder glob would also scan
  // schema/index.ts, whose re-exports drizzle-kit counts as duplicates.
  schema: [
    "./packages/db/src/schema/runs.ts",
    "./packages/db/src/schema/tasks.ts",
    "./packages/db/src/schema/artifacts.ts",
    "./packages/db/src/schema/claims.ts",
    "./packages/db/src/schema/ops.ts",
    "./packages/db/src/schema/views.ts",
  ],
  out: "./packages/db/migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://lab:lab@localhost:5434/research_lab",
  },
});
