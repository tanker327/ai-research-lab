// Mirrors docs/database-schema.md §6 — evidence, raw/canonical claims, links.
// Facts at collection time; judgments at evaluation time (ADR-013).
import {
  boolean,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { artifacts } from "./artifacts";
import { researchRuns } from "./runs";
import { attempts, researchTasks } from "./tasks";

export const evidence = pgTable("evidence", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id")
    .notNull()
    .references(() => researchRuns.id, { onDelete: "cascade" }),
  taskId: uuid("task_id")
    .notNull()
    .references(() => researchTasks.id),
  attemptId: uuid("attempt_id")
    .notNull()
    .references(() => attempts.id), // ownership (P9 / ADR-014)
  sourceClass: text("source_class").notNull(),
  sourceUrl: text("source_url"),
  sourceTitle: text("source_title"),
  publisher: text("publisher"),
  author: text("author"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  retrievedAt: timestamp("retrieved_at", { withTimezone: true }).notNull().defaultNow(),
  vendorAffiliated: boolean("vendor_affiliated"),
  benchmarkOrigin: text("benchmark_origin"),
  excerpt: text("excerpt").notNull(),
  artifactId: uuid("artifact_id").references(() => artifacts.id),
  metadata: jsonb("metadata").notNull().default({}),
});

export const rawClaims = pgTable("raw_claims", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id")
    .notNull()
    .references(() => researchRuns.id, { onDelete: "cascade" }),
  taskId: uuid("task_id")
    .notNull()
    .references(() => researchTasks.id),
  attemptId: uuid("attempt_id")
    .notNull()
    .references(() => attempts.id),
  canonicalClaimId: uuid("canonical_claim_id"), // FK added in migration after canonical_claims
  statement: text("statement").notNull(),
  subjectKey: text("subject_key").notNull(),
  predicateKey: text("predicate_key").notNull(),
  valueText: text("value_text"),
  type: text("type").notNull(),
  confidence: text("confidence"),
  createdByAgent: text("created_by_agent").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const canonicalClaims = pgTable(
  "canonical_claims",
  {
    id: uuid("id").primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => researchRuns.id, { onDelete: "cascade" }),
    subjectKey: text("subject_key").notNull(),
    predicateKey: text("predicate_key").notNull(),
    statement: text("statement").notNull(),
    type: text("type").notNull(),
    status: text("status").notNull().default("proposed"),
    contestNote: text("contest_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.runId, t.subjectKey, t.predicateKey)],
);

export const claimEvidenceLinks = pgTable(
  "claim_evidence_links",
  {
    canonicalClaimId: uuid("canonical_claim_id")
      .notNull()
      .references(() => canonicalClaims.id, { onDelete: "cascade" }),
    evidenceId: uuid("evidence_id")
      .notNull()
      .references(() => evidence.id, { onDelete: "cascade" }),
    relation: text("relation").notNull(),
  },
  (t) => [primaryKey({ columns: [t.canonicalClaimId, t.evidenceId] })],
);
