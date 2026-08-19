// Mirrors docs/database-schema.md §2 — the DDL is normative; keep in lockstep.
// TEXT-enum columns get their Zod-derived $type in ticket 0.4 (@lab/schemas).
// CHECK constraints and partial indexes live in migration 0001, not here (§10).
import { integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

export const researchRuns = pgTable("research_runs", {
  id: uuid("id").primaryKey(),
  title: text("title"),
  userRequest: text("user_request").notNull(),
  status: text("status").notNull().default("CREATED"),
  budget: jsonb("budget").notNull().default({}),
  evalCycleCount: integer("eval_cycle_count").notNull().default(0),
  specVersion: integer("spec_version").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  metadata: jsonb("metadata").notNull().default({}),
});

export const researchSpecs = pgTable(
  "research_specs",
  {
    id: uuid("id").primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => researchRuns.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    objective: text("objective").notNull(),
    scope: jsonb("scope").notNull().default([]),
    exclusions: jsonb("exclusions").notNull().default([]),
    constraints: jsonb("constraints").notNull().default([]),
    successCriteria: jsonb("success_criteria").notNull().default([]),
    keyQuestions: jsonb("key_questions").notNull().default([]),
    clarificationsAssumed: jsonb("clarifications_assumed").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.runId, t.version)],
);

export const planStages = pgTable(
  "plan_stages",
  {
    id: uuid("id").primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => researchRuns.id, { onDelete: "cascade" }),
    stage: integer("stage").notNull(),
    specVersion: integer("spec_version").notNull(),
    delta: jsonb("delta").notNull(),
    rationale: text("rationale").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.runId, t.stage)],
);
