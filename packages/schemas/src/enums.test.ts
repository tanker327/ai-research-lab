// Lockstep guard: the CHECK constraints in migration 0001 must list exactly the
// values of the corresponding Zod enums (database-schema.md §1: "the CHECK
// constraints mirror them"). Drift in either direction fails here.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ArtifactType,
  AttemptStatus,
  CanonicalClaimStatus,
  CheckpointStatus,
  ClaimConfidence,
  ClaimType,
  EvaluationTargetType,
  EvaluatorType,
  EventKind,
  EvidenceRelation,
  ModelTier,
  RunStatus,
  SourceClass,
  TaskStatus,
  TaskType,
} from "./enums";

const sql = readFileSync(new URL("../../db/migrations/0000_init.sql", import.meta.url), "utf8");

// The CHECK vocabulary for `column` within the CREATE TABLE statement of `table`.
function checkValues(table: string, column: string): string[] {
  const tableMatch = sql.match(new RegExp(`CREATE TABLE ${table} \\(([\\s\\S]*?)\\n\\);`));
  expect(tableMatch, `CREATE TABLE ${table} not found`).not.toBeNull();
  const body = tableMatch?.[1] as string;
  const check = body.match(
    new RegExp(`\\b${column}\\b[\\s\\S]*?CHECK \\(${column} IN \\(([^)]+)\\)\\)`),
  );
  expect(check, `CHECK for ${table}.${column} not found`).not.toBeNull();
  const list = check?.[1] as string;
  return [...list.matchAll(/'([^']+)'/g)].map((v) => v[1] as string).sort();
}

const cases: Array<[string, string, { options: readonly string[] }]> = [
  ["research_runs", "status", RunStatus],
  ["research_tasks", "status", TaskStatus],
  ["research_tasks", "type", TaskType],
  ["research_tasks", "model_tier", ModelTier],
  ["attempts", "status", AttemptStatus],
  ["artifacts", "type", ArtifactType],
  ["evidence", "source_class", SourceClass],
  ["raw_claims", "type", ClaimType],
  ["raw_claims", "confidence", ClaimConfidence],
  ["canonical_claims", "type", ClaimType],
  ["canonical_claims", "status", CanonicalClaimStatus],
  ["claim_evidence_links", "relation", EvidenceRelation],
  ["evaluations", "target_type", EvaluationTargetType],
  ["evaluations", "evaluator_type", EvaluatorType],
  ["events", "kind", EventKind],
  ["human_checkpoints", "status", CheckpointStatus],
];

describe("zod enums match migration CHECK constraints", () => {
  for (const [table, column, enumSchema] of cases) {
    it(`${table}.${column}`, () => {
      expect(checkValues(table, column)).toEqual([...enumSchema.options].sort());
    });
  }
});
