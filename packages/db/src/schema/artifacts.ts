// Mirrors docs/database-schema.md §5.
import { bigint, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { attempts, researchTasks } from "./tasks";
import { researchRuns } from "./runs";

export const artifacts = pgTable("artifacts", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id")
    .notNull()
    .references(() => researchRuns.id, { onDelete: "cascade" }),
  taskId: uuid("task_id").references(() => researchTasks.id),
  attemptId: uuid("attempt_id").references(() => attempts.id),
  type: text("type").notNull(),
  name: text("name").notNull(),
  mediaType: text("media_type").notNull().default("text/markdown"),
  storageUri: text("storage_uri").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }),
  sha256: text("sha256"),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  metadata: jsonb("metadata").notNull().default({}),
});
