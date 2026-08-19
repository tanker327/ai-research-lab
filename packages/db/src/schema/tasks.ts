// Mirrors docs/database-schema.md §3–4.

import { sql } from "drizzle-orm";
import {
  check,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { researchRuns } from "./runs";

export const researchTasks = pgTable("research_tasks", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id")
    .notNull()
    .references(() => researchRuns.id, { onDelete: "cascade" }),
  parentTaskId: uuid("parent_task_id"),
  planStage: integer("plan_stage").notNull().default(1),
  specVersion: integer("spec_version").notNull().default(1),
  type: text("type").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  status: text("status").notNull().default("CREATED"),
  priority: integer("priority").notNull().default(50),
  agentRole: text("agent_role").notNull(),
  agentVersion: text("agent_version").notNull().default("v1"),
  modelTier: text("model_tier"),
  strategy: text("strategy"),
  // STAGED PLANNING INVARIANT (ADR-011): input is fully concrete at creation.
  input: jsonb("input").notNull().default({}),
  successCriteria: jsonb("success_criteria").notNull().default([]),
  maxAttempts: integer("max_attempts").notNull().default(3),
  attemptCount: integer("attempt_count").notNull().default(0),
  claimedBy: text("claimed_by"),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  metadata: jsonb("metadata").notNull().default({}),
});

export const taskDependencies = pgTable(
  "task_dependencies",
  {
    taskId: uuid("task_id")
      .notNull()
      .references(() => researchTasks.id, { onDelete: "cascade" }),
    dependsOnTaskId: uuid("depends_on_task_id")
      .notNull()
      .references(() => researchTasks.id, { onDelete: "cascade" }),
    dependencyType: text("dependency_type").notNull().default("required"),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.dependsOnTaskId] }),
    check("task_dependencies_no_self", sql`${t.taskId} != ${t.dependsOnTaskId}`),
  ],
);

export const attempts = pgTable(
  "attempts",
  {
    id: uuid("id").primaryKey(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => researchTasks.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => researchRuns.id, { onDelete: "cascade" }),
    attemptNumber: integer("attempt_number").notNull(),
    status: text("status").notNull().default("CREATED"),
    agentName: text("agent_name").notNull(),
    agentVersion: text("agent_version").notNull(),
    model: text("model"),
    modelTier: text("model_tier"),
    strategy: text("strategy"),
    infraRetryCount: integer("infra_retry_count").notNull().default(0),
    // R12: input is the VERBATIM Context Builder product the agent received.
    input: jsonb("input").notNull().default({}),
    output: jsonb("output"),
    error: jsonb("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    metadata: jsonb("metadata").notNull().default({}),
  },
  (t) => [unique().on(t.taskId, t.attemptNumber)],
);
