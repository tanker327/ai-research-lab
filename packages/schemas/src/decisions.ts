// Control-plane decision shapes (implementation-plan §5.4, database-schema
// decision_records). Every retry/cycle-guard/budget verdict is persisted as a
// DecisionRecord whose rationale the trace UI renders verbatim (§24.2).
import { z } from "zod";

// Quality verdict on a SUCCEEDED attempt — produced by deterministic checks in
// Phase 1 and additionally by the Evaluator agent from Phase 4. Only
// `rejected` is control-relevant; reasons feed the DecisionRecord rationale.
export const QualityVerdict = z.object({
  rejected: z.boolean(),
  reasons: z.array(z.string()).default([]),
});
export type QualityVerdict = z.infer<typeof QualityVerdict>;

// decision_records.type is open-vocabulary TEXT in the DDL; this enum tracks
// the writers that exist. Extend additively as coordinators land.
export const DecisionType = z.enum(["retry_ladder", "cycle_guard", "budget", "replan"]);
export type DecisionType = z.infer<typeof DecisionType>;

export const DecisionRecord = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  taskId: z.string().uuid().nullable(),
  attemptId: z.string().uuid().nullable(),
  type: DecisionType,
  decision: z.string().min(1),
  rationale: z.string().min(1),
  createdBy: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type DecisionRecord = z.infer<typeof DecisionRecord>;
