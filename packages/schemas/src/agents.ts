// Agent I/O contracts for Phase 3 (design §6.1–6.3, §12). Inputs are Context
// Builder products persisted verbatim on the attempt (R12); outputs land with
// their agent tickets (3.2–3.4). D1 norm (phase-3-plan): every array and
// string is bounded — constrained decoding degenerates on unbounded shapes.
import { z } from "zod";
import { ModelTier, ResearchStrategy, TaskType } from "./enums";

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

// ---- Planner output (design §6.1, ticket 3.2) ----

// The version and all ids are assigned by the Control Plane — the model never
// mints identity or version numbers.
export const PlannerSpecDraft = ResearchSpecification.omit({
  version: true,
  clarificationsAssumed: true,
});
export type PlannerSpecDraft = z.infer<typeof PlannerSpecDraft>;

// CLOSED input shape (P3 norm): vLLM guided decoding 500s on open-keyed
// objects (z.record → additionalProperties), so planned-task input is an
// explicit, fully-bounded set of nullable fields. The plan interpreter turns
// it into the task's input record, dropping nulls (ADR-011: concrete values
// only).
export const PlannedTaskInput = z.object({
  researchQuestion: z.string().max(4000).nullable(),
  seedUrls: z.array(z.string().max(2000)).max(10).nullable(),
  excludedSources: z.array(z.string().max(2000)).max(20).nullable(),
  focus: z.string().max(2000).nullable(), // analyze/synthesize guidance
});
export type PlannedTaskInput = z.infer<typeof PlannedTaskInput>;

export const PlannedTask = z.object({
  localId: z.string().min(1).max(60),
  type: TaskType,
  title: z.string().min(1).max(500),
  description: z.string().max(4000).default(""),
  researchQuestion: z.string().max(4000).optional(),
  strategy: ResearchStrategy.optional(),
  priority: z.number().int().min(0).max(100),
  dependencies: z.array(z.string().min(1).max(60)).max(50),
  successCriteria: z.array(shortText).max(20),
  suggestedModelTier: ModelTier.optional(),
  parallelizable: z.boolean(),
  // Fully concrete at creation (ADR-011) — the interpreter enforces this with
  // the placeholder guard; the schema can only bound the shape.
  input: PlannedTaskInput,
});
export type PlannedTask = z.infer<typeof PlannedTask>;

export const PlanDelta = z.object({
  addTasks: z.array(PlannedTask).max(30),
  cancelTaskIds: z.array(z.string().max(60)).max(50),
  supersedeTaskIds: z.array(z.string().max(60)).max(50),
  rationale: z.string().min(1).max(4000),
});
export type PlanDelta = z.infer<typeof PlanDelta>;

export const HumanQuestion = z.object({
  question: shortText,
  whyUnsafeToInfer: shortText,
});
export type HumanQuestion = z.infer<typeof HumanQuestion>;

export const PlannerOutput = z.object({
  specification: PlannerSpecDraft,
  clarificationsAssumed: z.array(shortText).max(20),
  humanQuestions: z.array(HumanQuestion).max(5).optional(),
  planDelta: PlanDelta,
});
export type PlannerOutput = z.infer<typeof PlannerOutput>;

// ---- Researcher (design §6.2, ticket 3.3) ----

export const SelfAssessment = z.object({
  complete: z.boolean(),
  confidence: z.enum(["low", "medium", "high"]),
  gaps: z.array(shortText).max(10),
});
export type SelfAssessment = z.infer<typeof SelfAssessment>;

// One structured decision per loop iteration — the loop itself is code with a
// deterministic cap (ADR-016), never a model-terminated tool loop.
const stepFetch = z.object({
  action: z.literal("fetch"),
  url: z.string().max(2000),
  why: z.string().max(300),
});
const stepSearch = z.object({
  action: z.literal("search"),
  query: z.string().min(2).max(400),
  why: z.string().max(300),
});
const stepFinish = z.object({
  action: z.literal("finish"),
  // Markdown research note: Question / Method / Findings / Sources /
  // Contradictions noticed / Gaps (design §6.2 template). The floor is real:
  // a live model once "finished" with a 220-char header-only note; guided
  // decoding enforces minLength, so a lazy finish can't decode.
  note: z.string().min(600).max(20_000),
  selfAssessment: SelfAssessment,
});

export function researcherStepSchema(hasSearch: boolean) {
  return hasSearch
    ? z.discriminatedUnion("action", [stepFetch, stepSearch, stepFinish])
    : z.discriminatedUnion("action", [stepFetch, stepFinish]);
}
export type ResearcherStep = z.infer<ReturnType<typeof researcherStepSchema>>;

// Persisted attempt output. sourcesVisited is assembled MECHANICALLY by the
// worker from the attempt's tool_calls rows — never from model memory.
export const ResearcherOutput = z.object({
  noteArtifactId: z.string().max(40),
  sourcesVisited: z.array(SourceVisit).max(100),
  selfAssessment: SelfAssessment,
});
export type ResearcherOutput = z.infer<typeof ResearcherOutput>;

// ---- Extractor (design §6.3, ticket 3.4) ----
// Pass 2: guided decoding on the fast tier. Claims/evidence are PROPOSALS —
// the worker writes them as attempt-owned rows; they become live only when
// the attempt is accepted (ADR-014), and canonicalization (3.5) dedupes them.

export const ProposedClaim = z.object({
  statement: z.string().min(1).max(1000),
  subjectKey: z.string().min(1).max(200), // 'model:qwen3.6-27b'
  predicateKey: z.string().min(1).max(200), // 'param_count'
  valueText: z.string().max(500).nullable(), // normalized value for conflict detection
  type: z.enum(["fact", "comparison", "inference", "recommendation", "uncertainty"]),
  confidence: z.enum(["low", "medium", "high"]),
  // Indexes into ExtractorOutput.evidence supporting this claim.
  evidenceRefs: z.array(z.number().int().min(0).max(99)).max(10),
});
export type ProposedClaim = z.infer<typeof ProposedClaim>;

export const ProposedEvidence = z.object({
  excerpt: z.string().min(1).max(2000), // the actual supporting text from the note
  sourceUrl: z.string().max(2000).nullable(), // must come from sourcesVisited
  sourceClass: z.enum([
    "official_docs",
    "paper",
    "independent_benchmark",
    "vendor_benchmark",
    "news",
    "community",
    "user_supplied",
  ]),
  publisher: z.string().max(300).nullable(),
  publishedAt: z.string().max(40).nullable(), // ISO date if the source shows one
  vendorAffiliated: z.boolean().nullable(), // null = unknown (checks treat as vendor)
  benchmarkOrigin: z.string().max(200).nullable(), // underlying benchmark identity (§9)
});
export type ProposedEvidence = z.infer<typeof ProposedEvidence>;

export const ExtractorOutput = z.object({
  claims: z.array(ProposedClaim).max(50),
  evidence: z.array(ProposedEvidence).max(100),
  contradictionsNoticed: z
    .array(
      z.object({
        subject: z.string().max(200),
        detail: z.string().max(1000),
      }),
    )
    .max(20),
  unanswered: z.array(shortText).max(20),
});
export type ExtractorOutput = z.infer<typeof ExtractorOutput>;

// The extract task's `input` column IS this shape, written fully concrete by
// the Control Plane when the research attempt is accepted (ADR-011, plan D5) —
// so the builder is a validation pass, not a query.
export const ExtractorInput = z.object({
  noteArtifactId: z.string().max(40),
  sourcesVisited: z.array(SourceVisit).max(100),
  question: z.string().max(4000),
});
export type ExtractorInput = z.infer<typeof ExtractorInput>;
