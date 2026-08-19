// Mirrors docs/database-schema.md §7 — evaluations, decisions, events, calls, checkpoints.
import {
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { artifacts } from "./artifacts";
import { researchRuns } from "./runs";
import { attempts, researchTasks } from "./tasks";

export const evaluations = pgTable("evaluations", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id")
    .notNull()
    .references(() => researchRuns.id, { onDelete: "cascade" }),
  targetType: text("target_type").notNull(),
  targetId: uuid("target_id").notNull(),
  evaluatorType: text("evaluator_type").notNull(),
  evaluatorName: text("evaluator_name").notNull(),
  decision: text("decision").notNull(),
  reasons: jsonb("reasons").notNull().default([]),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const decisionRecords = pgTable("decision_records", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id")
    .notNull()
    .references(() => researchRuns.id, { onDelete: "cascade" }),
  taskId: uuid("task_id").references(() => researchTasks.id),
  attemptId: uuid("attempt_id").references(() => attempts.id),
  type: text("type").notNull(),
  decision: text("decision").notNull(),
  rationale: text("rationale").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  metadata: jsonb("metadata").notNull().default({}),
});

export const events = pgTable("events", {
  id: uuid("id").primaryKey(), // UUIDv7 → chronological PK scan order
  runId: uuid("run_id")
    .notNull()
    .references(() => researchRuns.id, { onDelete: "cascade" }),
  taskId: uuid("task_id").references(() => researchTasks.id),
  attemptId: uuid("attempt_id").references(() => attempts.id),
  type: text("type").notNull(),
  kind: text("kind").notNull().default("info"),
  actor: text("actor").notNull(),
  payload: jsonb("payload").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const modelCalls = pgTable("model_calls", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id")
    .notNull()
    .references(() => researchRuns.id, { onDelete: "cascade" }),
  attemptId: uuid("attempt_id")
    .notNull()
    .references(() => attempts.id),
  model: text("model").notNull(),
  modelTier: text("model_tier").notNull(),
  purpose: text("purpose").notNull().default("agent"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  costUsd: numeric("cost_usd", { precision: 10, scale: 6 }),
  latencyMs: integer("latency_ms").notNull(),
  finishReason: text("finish_reason"),
  reasoningArtifactId: uuid("reasoning_artifact_id").references(() => artifacts.id), // R11
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const toolCalls = pgTable(
  "tool_calls",
  {
    id: uuid("id").primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => researchRuns.id, { onDelete: "cascade" }),
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => attempts.id),
    seq: integer("seq").notNull(),
    toolName: text("tool_name").notNull(),
    request: jsonb("request").notNull(),
    responseSnippet: text("response_snippet"),
    responseArtifactId: uuid("response_artifact_id").references(() => artifacts.id),
    error: jsonb("error"),
    latencyMs: integer("latency_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.attemptId, t.seq)],
);

export const humanCheckpoints = pgTable("human_checkpoints", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id")
    .notNull()
    .references(() => researchRuns.id, { onDelete: "cascade" }),
  taskId: uuid("task_id").references(() => researchTasks.id),
  reason: text("reason").notNull(),
  question: text("question").notNull(),
  options: jsonb("options").notNull().default([]),
  status: text("status").notNull().default("pending"),
  response: jsonb("response"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});
