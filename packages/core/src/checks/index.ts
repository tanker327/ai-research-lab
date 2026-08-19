// Deterministic pre-accept checks (ticket 3.6, design §14 pre-checks). Pure
// functions — they decide WHETHER an output is rejected; decideRetry decides
// what happens next (rule 10). They run only when the attempt output parses
// as the real agent contract, so fake-handler attempts (demos, gates) skip.
import type { ExtractorOutput, ResearcherOutput } from "@lab/schemas";

export interface CheckFailure {
  check: string; // 'check:min_evidence' — evaluations.evaluator_name
  reason: string; // human-readable; trace control-blocks render verbatim (§24.2)
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
    });
  }
  // Vendor rule: when everything supporting the extraction is
  // vendor-affiliated (NULL = unknown = vendor for safety), demand one
  // independent source before accepting.
  if (stats.evidenceCount > 0 && stats.nonVendorCount === 0) {
    failures.push({
      check: "check:non_vendor",
      reason: `vendor-product coverage requires ≥1 non-vendor-affiliated source; found 0/${stats.evidenceCount}`,
    });
  }
  if (output.claims.length === 0) {
    failures.push({
      check: "check:min_claims",
      reason: "extraction produced zero claims — the note does not support the question",
    });
  }
  return failures;
}
