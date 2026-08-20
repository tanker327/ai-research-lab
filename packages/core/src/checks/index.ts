// Deterministic pre-accept checks (ticket 3.6, design §14 pre-checks). Pure
// functions — they decide WHETHER an output is rejected; decideRetry decides
// what happens next (rule 10). They run only when the attempt output parses
// as the real agent contract, so fake-handler attempts (demos, gates) skip.
import type {
  AnalysisOutput,
  EvaluatorOutput,
  ExtractorOutput,
  ResearcherOutput,
} from "@lab/schemas";
import { PLACEHOLDER } from "../plan";

export interface CheckFailure {
  check: string; // 'check:min_evidence' — evaluations.evaluator_name
  reason: string; // human-readable; trace control-blocks render verbatim (§24.2)
  // 'reject' fails the attempt onto the ladder; 'warn' records an advisory
  // evaluations row + warn event and lets the accept proceed. The vendor rule
  // is advisory in V0.05 (P3 gate finding): a question about PostgreSQL makes
  // postgresql.org "vendor" — applicability needs the Evaluator's judgment
  // (P4), not a blanket deterministic reject.
  severity: "reject" | "warn";
}

export interface EvidenceStats {
  evidenceCount: number;
  nonVendorCount: number; // vendor_affiliated = false ONLY (null counts as vendor, for safety)
}

// Self-assessment rule: an incomplete, low-confidence pass-1 is rejected
// before it wastes an extract cycle — the ladder retries with a new strategy.
export function researcherPreAcceptChecks(output: ResearcherOutput): CheckFailure[] {
  const failures: CheckFailure[] = [];
  const sa = output.selfAssessment;
  if (!sa.complete && sa.confidence === "low") {
    failures.push({
      check: "check:self_assessment",
      reason: `researcher self-assessed incomplete with low confidence; gaps: ${sa.gaps.join("; ") || "(none listed)"}`,
      severity: "reject",
    });
  }
  return failures;
}

export function extractorPreAcceptChecks(
  output: ExtractorOutput,
  stats: EvidenceStats,
  minEvidence: number,
): CheckFailure[] {
  const failures: CheckFailure[] = [];
  if (stats.evidenceCount < minEvidence) {
    failures.push({
      check: "check:min_evidence",
      reason: `research task requires ≥${minEvidence} live evidence items; found ${stats.evidenceCount}`,
      severity: "reject",
    });
  }
  // Vendor rule: when everything supporting the extraction is
  // vendor-affiliated (NULL = unknown = vendor for safety), demand one
  // independent source before accepting.
  if (stats.evidenceCount > 0 && stats.nonVendorCount === 0) {
    failures.push({
      check: "check:non_vendor",
      reason: `all ${stats.evidenceCount} evidence items are vendor-affiliated — an independent source would strengthen this`,
      severity: "warn",
    });
  }
  if (output.claims.length === 0) {
    failures.push({
      check: "check:min_claims",
      reason: "extraction produced zero claims — the note does not support the question",
      severity: "reject",
    });
  }
  return failures;
}

// Findings-cite-claims (ticket 4.2, design §6.4): every id an analysis cites
// must be a live canonical claim. Zero-citation findings can't decode (schema
// min 1); this closes the other hole — invented or stale ids. Referential
// integrity is code, not prompt.
export function analystPreAcceptChecks(
  output: AnalysisOutput,
  liveClaimIds: ReadonlySet<string>,
): CheckFailure[] {
  const cited = [
    ...output.findings.flatMap((f) => f.canonicalClaimIds),
    ...output.comparisons.flatMap((c) => c.canonicalClaimIds),
  ];
  const unknown = [...new Set(cited.filter((id) => !liveClaimIds.has(id)))];
  if (unknown.length === 0) return [];
  return [
    {
      check: "check:findings_cite_claims",
      reason: `analysis cites ${unknown.length} id(s) that are not live canonical claims: ${unknown.slice(0, 5).join(", ")}${unknown.length > 5 ? ", …" : ""}`,
      severity: "reject",
    },
  ];
}

// Evaluator consistency checks (ticket 4.3, phase-4-plan D6): mechanical
// anti-rubber-stamp rules (ADR-015's split criterion made code) — the merged
// critic+judge may not find critical flaws and accept anyway, may not demand
// more work without saying what work, and may not emit template-ish actions.
export function evaluatorPreAcceptChecks(output: EvaluatorOutput): CheckFailure[] {
  const failures: CheckFailure[] = [];
  if (
    (output.decision === "RESEARCH_MORE" || output.decision === "REPLAN") &&
    output.requiredActions.length === 0
  ) {
    failures.push({
      check: "check:actions_required",
      reason: `decision ${output.decision} with zero requiredActions — gaps must arrive as concrete actions`,
      severity: "reject",
    });
  }
  if (output.decision === "ACCEPT" && output.issues.some((i) => i.severity === "critical")) {
    failures.push({
      check: "check:no_rubber_stamp",
      reason:
        "ACCEPT with an open critical issue — resolve it, demand the work, or consciously downgrade it with acceptedUncertainties",
      severity: "reject",
    });
  }
  for (const a of output.requiredActions) {
    if (PLACEHOLDER.test(a.question)) {
      failures.push({
        check: "check:concrete_actions",
        reason: `requiredAction question contains placeholder text: ${a.question.slice(0, 120)}`,
        severity: "reject",
      });
    }
  }
  return failures;
}

export * from "./citations";
