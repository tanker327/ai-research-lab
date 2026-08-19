// THE single TS source for status/vocabulary enums (CLAUDE.md rule 2).
// The CHECK constraints in packages/db/migrations mirror these — lockstep is
// asserted by enums.test.ts, which parses the migration SQL. Additive changes
// touch both this file and a new migration.
import { z } from "zod";

export const RunStatus = z.enum([
  "CREATED",
  "PLANNING",
  "RESEARCHING",
  "ANALYZING",
  "EVALUATING",
  "SYNTHESIZING",
  "WAITING_HUMAN",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);
export type RunStatus = z.infer<typeof RunStatus>;

export const TaskStatus = z.enum([
  "CREATED",
  "READY",
  "RUNNING",
  "EVALUATING",
  "DONE",
  "FAILED",
  "BLOCKED",
  "WAITING_HUMAN",
  "CANCELLED",
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const TaskType = z.enum([
  "plan",
  "research",
  "extract",
  "analyze",
  "evaluate",
  "synthesize",
  "human_review",
]);
export type TaskType = z.infer<typeof TaskType>;

export const AttemptStatus = z.enum([
  "CREATED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "ACCEPTED",
  "REJECTED",
  "SUPERSEDED",
  "CANCELLED",
]);
export type AttemptStatus = z.infer<typeof AttemptStatus>;

export const EventKind = z.enum(["info", "accept", "gate", "warn", "fail"]);
export type EventKind = z.infer<typeof EventKind>;

export const ModelTier = z.enum(["frontier", "strong_local", "fast_local", "cheap_remote"]);
export type ModelTier = z.infer<typeof ModelTier>;

// design §6.2 — research tasks only ("experimental" deferred to V0.2). Stored
// in research_tasks.strategy / attempts.strategy (TEXT, no CHECK — additive
// vocabulary), so this enum is the sole validator.
export const ResearchStrategy = z.enum([
  "broad_discovery",
  "primary_sources",
  "benchmark_focused",
  "community_evidence",
  "independent_validation",
  "comparative",
]);
export type ResearchStrategy = z.infer<typeof ResearchStrategy>;

export const ArtifactType = z.enum([
  "research_note",
  "reasoning",
  "page_snapshot",
  "tool_response",
  "analysis_memo",
  "report",
  "other",
]);
export type ArtifactType = z.infer<typeof ArtifactType>;

export const SourceClass = z.enum([
  "official_docs",
  "paper",
  "independent_benchmark",
  "vendor_benchmark",
  "news",
  "community",
  "user_supplied",
]);
export type SourceClass = z.infer<typeof SourceClass>;

export const ClaimType = z.enum([
  "fact",
  "comparison",
  "inference",
  "recommendation",
  "uncertainty",
]);
export type ClaimType = z.infer<typeof ClaimType>;

export const ClaimConfidence = z.enum(["low", "medium", "high"]);
export type ClaimConfidence = z.infer<typeof ClaimConfidence>;

export const CanonicalClaimStatus = z.enum([
  "proposed",
  "supported",
  "contested",
  "rejected",
  "approved",
]);
export type CanonicalClaimStatus = z.infer<typeof CanonicalClaimStatus>;

export const EvidenceRelation = z.enum(["supports", "contradicts", "context"]);
export type EvidenceRelation = z.infer<typeof EvidenceRelation>;

export const EvaluationTargetType = z.enum(["attempt", "task", "analysis", "report", "run"]);
export type EvaluationTargetType = z.infer<typeof EvaluationTargetType>;

export const EvaluatorType = z.enum(["rule", "agent", "human"]);
export type EvaluatorType = z.infer<typeof EvaluatorType>;

export const CheckpointStatus = z.enum(["pending", "resolved", "cancelled"]);
export type CheckpointStatus = z.infer<typeof CheckpointStatus>;
