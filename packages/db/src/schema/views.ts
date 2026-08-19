// Liveness views (docs/database-schema.md §8, ADR-014 made queryable).
// Created in raw SQL by migration 0001; modeled read-only here via pgView.
// packages/context, packages/evidence, and every read API query THESE —
// base-table reads outside packages/db repositories and the trace assembler
// are a code-review reject (CLAUDE.md rule 5).
import { boolean, jsonb, pgView, text, timestamp, uuid } from "drizzle-orm/pg-core";

const evidenceColumns = () => ({
  id: uuid("id").notNull(),
  runId: uuid("run_id").notNull(),
  taskId: uuid("task_id").notNull(),
  attemptId: uuid("attempt_id").notNull(),
  sourceClass: text("source_class").notNull(),
  sourceUrl: text("source_url"),
  sourceTitle: text("source_title"),
  publisher: text("publisher"),
  author: text("author"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  retrievedAt: timestamp("retrieved_at", { withTimezone: true }).notNull(),
  vendorAffiliated: boolean("vendor_affiliated"),
  benchmarkOrigin: text("benchmark_origin"),
  excerpt: text("excerpt").notNull(),
  artifactId: uuid("artifact_id"),
  metadata: jsonb("metadata").notNull(),
});

export const liveEvidence = pgView("live_evidence", evidenceColumns()).existing();

export const liveRawClaims = pgView("live_raw_claims", {
  id: uuid("id").notNull(),
  runId: uuid("run_id").notNull(),
  taskId: uuid("task_id").notNull(),
  attemptId: uuid("attempt_id").notNull(),
  canonicalClaimId: uuid("canonical_claim_id"),
  statement: text("statement").notNull(),
  subjectKey: text("subject_key").notNull(),
  predicateKey: text("predicate_key").notNull(),
  valueText: text("value_text"),
  type: text("type").notNull(),
  confidence: text("confidence"),
  createdByAgent: text("created_by_agent").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}).existing();

export const liveCanonicalClaims = pgView("live_canonical_claims", {
  id: uuid("id").notNull(),
  runId: uuid("run_id").notNull(),
  subjectKey: text("subject_key").notNull(),
  predicateKey: text("predicate_key").notNull(),
  statement: text("statement").notNull(),
  type: text("type").notNull(),
  status: text("status").notNull(),
  contestNote: text("contest_note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
}).existing();

export const liveClaimEvidence = pgView("live_claim_evidence", {
  canonicalClaimId: uuid("canonical_claim_id").notNull(),
  relation: text("relation").notNull(),
  ...evidenceColumns(),
}).existing();
