// Agent I/O contracts for Phase 3 (design §6.1–6.3, §12). Inputs are Context
// Builder products persisted verbatim on the attempt (R12); outputs land with
// their agent tickets (3.2–3.4). D1 norm (phase-3-plan): every array and
// string is bounded — constrained decoding degenerates on unbounded shapes.
import { z } from "zod";
import { CoverageSummary } from "./coverage";
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
  // REPLAN only (design §7): the Evaluator's verdict that demanded this
  // stage. Declared lazily — EvaluatorOutput is defined later in this module.
  evaluatorFeedback: z
    .object({
      decision: z.string().max(40),
      reasons: z.array(z.string().max(2000)).max(10),
      issues: z
        .array(z.object({ severity: z.string().max(20), description: z.string().max(2000) }))
        .max(20),
      requiredActions: z
        .array(z.object({ question: z.string().max(500), rationale: z.string().max(1000) }))
        .max(10),
    })
    .optional(),
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
  // V0.05: the Planner plans RESEARCH and ANALYZE only. extract tasks are
  // control-plane-created after research accept (ADR-012); evaluate/
  // synthesize/plan tasks are coordinator-owned (P4/P5 widen this). Found
  // live: a frontier planner invented extract+synthesize tasks that could
  // never run. Schema-level so guided decoding blocks it at the source.
  type: z.enum(["research", "analyze"]),
  title: z.string().min(1).max(500),
  description: z.string().max(4000).default(""),
  researchQuestion: z.string().max(4000).optional(),
  strategy: ResearchStrategy.optional(),
  priority: z.number().int().min(0).max(100),
  dependencies: z.array(z.string().min(1).max(60)).max(50),
  successCriteria: z.array(shortText).max(20),
  // Only tiers with configured models in V0.05 — a live planner suggested
  // cheap_remote, which since 4.5 routes for real and has no alias (gate
  // finding: three research tasks died PERMANENT_INFRA at claim time).
  suggestedModelTier: z.enum(["frontier", "strong_local", "fast_local"]).optional(),
  parallelizable: z.boolean(),
  // Fully concrete at creation (ADR-011) — the interpreter enforces this with
  // the placeholder guard; the schema can only bound the shape.
  input: PlannedTaskInput,
});
export type PlannedTask = z.infer<typeof PlannedTask>;

export const PlanDelta = z.object({
  addTasks: z.array(PlannedTask).max(30),
  cancelTaskIds: z.array(z.string().max(60)).max(50).default([]),
  supersedeTaskIds: z.array(z.string().max(60)).max(50).default([]),
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
  // json_object norm (gate finding): frontier models omit empty arrays —
  // semantically-optional lists carry .default([]) so an omitted empty list
  // is not a SCHEMA_FAILURE. Type violations still fail hard.
  clarificationsAssumed: z.array(shortText).max(20).default([]),
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
  // Page through long documents: refetch with the offset where the previous
  // excerpt window ended (null = start of page).
  startChar: z.number().int().min(0).max(5_000_000).nullable(),
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
  // Tight caps (gate finding): over-extraction + reasoning tokens truncated
  // the JSON mid-array on the fast tier. Fewer, stronger items.
  claims: z.array(ProposedClaim).max(20),
  evidence: z.array(ProposedEvidence).max(30),
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

// ---- Analyst (design §6.4, ticket 4.2) ----
// Reads ONLY live canonical claims + evidence via the Context Builder (P9);
// findings must cite claim ids — a finding with zero citations cannot decode
// (min 1), and unknown ids are a deterministic pre-accept reject.

export const EvidenceView = z.object({
  relation: z.string().max(40),
  sourceClass: z.string().max(40),
  sourceUrl: z.string().max(2000).nullable(),
  vendorAffiliated: z.boolean().nullable(), // null = unknown (treated as vendor)
  benchmarkOrigin: z.string().max(200).nullable(),
  excerpt: z.string().max(1000),
});
export type EvidenceView = z.infer<typeof EvidenceView>;

export const CanonicalClaimView = z.object({
  id: z.string().max(40),
  subjectKey: z.string().max(200),
  predicateKey: z.string().max(200),
  statement: z.string().max(1000),
  status: z.string().max(40),
  contestNote: z.string().max(2000).nullable(),
  evidence: z.array(EvidenceView).max(3), // K=3 strongest (design §12)
});
export type CanonicalClaimView = z.infer<typeof CanonicalClaimView>;

export const ContestedClaimView = z.object({
  claimId: z.string().max(40),
  statement: z.string().max(1000),
  contestNote: z.string().max(2000),
});
export type ContestedClaimView = z.infer<typeof ContestedClaimView>;

export const AnalystInput = z.object({
  specification: ResearchSpecification,
  claimBundle: z.array(CanonicalClaimView).max(300),
  openContests: z.array(ContestedClaimView).max(50),
  timeContext: z.string().max(500),
});
export type AnalystInput = z.infer<typeof AnalystInput>;

export const Finding = z.object({
  statement: z.string().min(1).max(2000),
  canonicalClaimIds: z.array(z.string().max(40)).min(1).max(20),
  implication: z.string().max(2000).nullable(), // what it means for the user's goal
});
export type Finding = z.infer<typeof Finding>;

export const Comparison = z.object({
  topic: z.string().min(1).max(200),
  statement: z.string().min(1).max(2000),
  canonicalClaimIds: z.array(z.string().max(40)).min(1).max(20),
});
export type Comparison = z.infer<typeof Comparison>;

export const AnalysisOutput = z.object({
  findings: z.array(Finding).min(1).max(20),
  comparisons: z.array(Comparison).max(10).default([]),
  unresolvedQuestions: z.array(shortText).max(15).default([]),
  confidenceNote: z.string().min(1).max(2000), // prose calibration, not a fake float
});
export type AnalysisOutput = z.infer<typeof AnalysisOutput>;

// ---- Evaluator (design §6.5, ticket 4.3) ----
// Merged Critic + Judge (ADR-015). One frontier call per cycle. The output is
// a DECISION the Control Plane interprets (ADR-003) — it never mutates tasks,
// and the cycle guard bounding the loop is code (ADR-016), not this contract.

export const RunMetrics = z.object({
  attemptsUsed: z.number().int().nonnegative(),
  tasksDone: z.number().int().nonnegative(),
  tasksFailed: z.number().int().nonnegative(),
  cyclesCompleted: z.number().int().nonnegative(), // accepted evaluate attempts so far
  costUsd: z.number().nonnegative().nullable(),
});
export type RunMetrics = z.infer<typeof RunMetrics>;

export const EvaluatorInput = z.object({
  specification: ResearchSpecification,
  analysis: AnalysisOutput,
  claimBundle: z.array(CanonicalClaimView).max(300), // K=1 — coverage carries the stats
  coverage: CoverageSummary, // deterministic computed facts (D2) — never recount evidence
  runMetrics: RunMetrics,
  maxCycles: z.number().int().min(1).max(10), // so RESEARCH_MORE on the last cycle is informed
  timeContext: z.string().max(500),
});
export type EvaluatorInput = z.infer<typeof EvaluatorInput>;

export const EvaluatorIssue = z.object({
  severity: z.enum(["low", "medium", "high", "critical"]),
  category: z.enum([
    "source_quality",
    "missing_evidence",
    "contradiction",
    "reasoning",
    "scope",
    "recency",
    "benchmark_validity",
    "bias",
    "other",
  ]),
  description: z.string().min(1).max(2000),
  suggestedResearchQuestion: z.string().max(500).nullable(),
});
export type EvaluatorIssue = z.infer<typeof EvaluatorIssue>;

// V0.05 has exactly one action kind; the enum leaves room for more without a
// shape change (phase-4-plan D3). Question floors are real: a template-ish or
// empty question is caught by the placeholder guard at interpretation.
export const RequiredAction = z.object({
  kind: z.enum(["research"]),
  question: z.string().min(12).max(500),
  seedUrls: z.array(z.string().max(2000)).max(5).nullable(),
  rationale: z.string().min(1).max(1000),
});
export type RequiredAction = z.infer<typeof RequiredAction>;

export const EvaluatorDecision = z.enum([
  "ACCEPT",
  "RESEARCH_MORE",
  "REANALYZE",
  "REPLAN",
  "ESCALATE",
  "STOP",
]);
export type EvaluatorDecision = z.infer<typeof EvaluatorDecision>;

export const EvaluatorOutput = z.object({
  issues: z.array(EvaluatorIssue).max(20).default([]), // the "critic" half
  decision: EvaluatorDecision,
  reasons: z.array(z.string().min(1).max(2000)).min(1).max(10),
  requiredActions: z.array(RequiredAction).max(10).default([]),
  acceptedUncertainties: z.array(shortText).max(10).default([]), // surfaced in the report (P5)
});
export type EvaluatorOutput = z.infer<typeof EvaluatorOutput>;

// ---- Synthesizer (design §6.6, §24.4, ticket 5.1, phase-5-plan D1/D2/D5) ----
// Frontier, ONE call per run, NO tools (§18: no web — cannot import uncited
// facts). The agent writes report markdown with inline [cN] chips plus a
// citationMap; the deterministic citation validator (5.2, ADR-020) gates
// acceptance — every body sentence outside Uncertainties must cite.

export const SynthesizerInput = z.object({
  specification: ResearchSpecification,
  // The judgment the run completed under — approved material ONLY (D5).
  analysis: AnalysisOutput,
  claimBundle: z.array(CanonicalClaimView).max(300), // K=2 citation-ready refs
  openContests: z.array(ContestedClaimView).max(50),
  // From the final ACCEPT verdict — each MUST appear in the report's
  // Uncertainties section (§6.6: a promise to the user, not a footnote).
  acceptedUncertainties: z.array(shortText).max(10),
  // Rule-check REJECT reasons from prior attempts of THIS task (5.2): a
  // citation-validator rejection must be fixable, not replayed.
  rejectionFeedback: z.array(shortText).max(10).default([]),
  timeContext: z.string().max(500),
});
export type SynthesizerInput = z.infer<typeof SynthesizerInput>;

export const SynthesizerOutput = z.object({
  title: z.string().min(1).max(300),
  // Markdown with [c1], [c2]… chip tokens at the ends of cited sentences.
  // The worker persists this as the run's `report` artifact (D2).
  reportMarkdown: z.string().min(1).max(120_000),
  // chipId (without brackets, e.g. "c1") → canonical claim ids it cites.
  citationMap: z.record(
    z.string().min(1).max(20),
    z.array(z.string().min(1).max(40)).min(1).max(20),
  ),
});
export type SynthesizerOutput = z.infer<typeof SynthesizerOutput>;
