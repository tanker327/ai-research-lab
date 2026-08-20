// CoverageSummary (ticket 4.1, design §9 R5/§12, schema doc §9.4, phase-4-plan
// D2). Deterministic facts computed from live evidence/claims — the Evaluator
// reasons over these instead of recounting evidence itself. A claim's key
// question is DERIVED from the research task that produced it (raw_claims
// lineage), never asked of an agent. Persisted verbatim on evaluation rows
// (evaluations.metadata.coverage) so cycles are comparable in the console.
import { z } from "zod";

export const QuestionCoverage = z.object({
  question: z.string().min(1).max(500),
  taskStatus: z.string().max(40), // DONE | FAILED | … — failure visibility (ADR-010)
  evidenceCount: z.number().int().nonnegative(),
  claimCount: z.number().int().nonnegative(),
  distinctPublishers: z.number().int().nonnegative(),
  vendorRatio: z.number().min(0).max(1), // NULL vendor_affiliated counts as vendor (safety)
});
export type QuestionCoverage = z.infer<typeof QuestionCoverage>;

export const SourceClassCount = z.object({
  sourceClass: z.string().max(40),
  count: z.number().int().nonnegative(),
});
export type SourceClassCount = z.infer<typeof SourceClassCount>;

export const CoverageSummary = z.object({
  evidenceCount: z.number().int().nonnegative(),
  claimCount: z.number().int().nonnegative(),
  contestedCount: z.number().int().nonnegative(),
  distinctPublishers: z.number().int().nonnegative(),
  distinctOrigins: z.number().int().nonnegative(),
  vendorRatio: z.number().min(0).max(1),
  sourceClassMix: z.array(SourceClassCount).max(20),
  perQuestion: z.array(QuestionCoverage).max(40),
  oldestEvidence: z.string().max(40).nullable(), // ISO dates; null = no dated evidence
  newestEvidence: z.string().max(40).nullable(),
});
export type CoverageSummary = z.infer<typeof CoverageSummary>;
