// Agent I/O contracts for Phase 3 (design §6.1–6.3, §12). Inputs are Context
// Builder products persisted verbatim on the attempt (R12); outputs land with
// their agent tickets (3.2–3.4). D1 norm (phase-3-plan): every array and
// string is bounded — constrained decoding degenerates on unbounded shapes.
import { z } from "zod";
import { ResearchStrategy } from "./enums";

const shortText = z.string().max(2000);
const digestText = z.string().max(60_000);

// Mechanical fetch log from the tool layer (tool_calls rows) — never model
// memory (design §6.2).
export const SourceVisit = z.object({
  url: z.string().max(2000),
  title: z.string().max(500).nullish(),
  httpStatus: z.number().int().nullish(),
  retrievedAt: z.string().max(40),
  snapshotArtifactId: z.string().max(40).nullish(),
});
export type SourceVisit = z.infer<typeof SourceVisit>;

// design §6.1 / db research_specs. Version semantics: design §13.
export const ResearchSpecification = z.object({
  version: z.number().int().min(1),
  objective: shortText,
  scope: z.array(shortText).max(20),
  exclusions: z.array(shortText).max(20),
  constraints: z.array(shortText).max(20),
  successCriteria: z.array(shortText).max(20),
  keyQuestions: z.array(shortText).max(20),
  clarificationsAssumed: z.array(shortText).max(20),
});
export type ResearchSpecification = z.infer<typeof ResearchSpecification>;

// One-paragraph completed-task summary for stage-≥2 planning (design §12) —
// rendered deterministically by the Context Builder, never by a model.
export const TaskResultSummary = z.object({
  taskId: z.string().max(40),
  title: z.string().max(500),
  type: z.string().max(40),
  summary: z.string().max(1500),
});
export type TaskResultSummary = z.infer<typeof TaskResultSummary>;

export const CapabilitySummary = z.object({
  name: z.string().max(100),
  description: z.string().max(500),
});
export type CapabilitySummary = z.infer<typeof CapabilitySummary>;

export const PlannerInput = z.object({
  userRequest: z.string().max(10_000),
  suppliedConstraints: z.array(shortText).max(20).optional(),
  specification: ResearchSpecification.optional(), // absent on stage 1
  planStage: z.number().int().min(1).max(20),
  completedTaskSummaries: z.array(TaskResultSummary).max(100).optional(), // stage ≥ 2
  liveClaimDigest: digestText.optional(), // Context Builder rendering, code not LLM
  availableCapabilities: z.array(CapabilitySummary).max(20),
});
export type PlannerInput = z.infer<typeof PlannerInput>;

export const ResearcherInput = z.object({
  question: z.string().max(4000),
  strategy: ResearchStrategy,
  successCriteria: z.array(shortText).max(20),
  liveEvidenceDigest: digestText.optional(), // same-subject only (design §12)
  excludedSources: z.array(z.string().max(2000)).max(50).optional(),
  seedUrls: z.array(z.string().max(2000)).max(20).optional(), // phase-3-plan D4
  timeContext: z.string().max(500),
});
export type ResearcherInput = z.infer<typeof ResearcherInput>;

// The extract task's `input` column IS this shape, written fully concrete by
// the Control Plane when the research attempt is accepted (ADR-011, plan D5) —
// so the builder is a validation pass, not a query.
export const ExtractorInput = z.object({
  noteArtifactId: z.string().max(40),
  sourcesVisited: z.array(SourceVisit).max(100),
  question: z.string().max(4000),
});
export type ExtractorInput = z.infer<typeof ExtractorInput>;
