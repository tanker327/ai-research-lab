// Deterministic digest renderers (design §12). These are code, not an LLM
// summarizer — the same rows always render the same string, so digests are
// reproducible from the attempt's persisted input (R12).
import type { DoneTaskRow, LiveClaimEvidenceRow, LiveClaimRow } from "@lab/db";
import type { TaskResultSummary } from "@lab/schemas";

// Per-claim evidence cap K (design §12; overflow tightens it — see budget.ts).
export const DEFAULT_EVIDENCE_K = 3;

export interface ClaimDigestOptions {
  evidenceK: number;
  includeContextRelation: boolean;
  includeExcerpts: boolean;
}

export const FULL_DIGEST: ClaimDigestOptions = {
  evidenceK: DEFAULT_EVIDENCE_K,
  includeContextRelation: true,
  includeExcerpts: true,
};

function evidenceLine(e: LiveClaimEvidenceRow, includeExcerpt: boolean): string {
  const bits = [
    e.relation,
    e.sourceClass,
    e.vendorAffiliated ? "vendor-affiliated" : null,
    e.benchmarkOrigin ? `benchmark:${e.benchmarkOrigin}` : null,
    e.sourceUrl,
  ].filter(Boolean);
  const excerpt = includeExcerpt ? ` — "${e.excerpt.slice(0, 300)}"` : "";
  return `    · [${bits.join(", ")}]${excerpt}`;
}

// V0.05 strength heuristic (design §12): prefer distinct benchmarkOrigin,
// non-vendor-affiliated, then most recent (rows arrive recent-first per claim).
export function pickStrongest(evidence: LiveClaimEvidenceRow[], k: number): LiveClaimEvidenceRow[] {
  const scored = evidence.map((e, i) => ({
    e,
    score: (e.vendorAffiliated ? 0 : 2) + (e.benchmarkOrigin ? 1 : 0) - i * 0.001,
  }));
  scored.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const out: LiveClaimEvidenceRow[] = [];
  for (const { e } of scored) {
    const origin = e.benchmarkOrigin ?? `__row${out.length}`;
    if (e.benchmarkOrigin && seen.has(origin)) continue; // vendor-echo dedup seed (§9)
    seen.add(origin);
    out.push(e);
    if (out.length >= k) break;
  }
  return out;
}

// Canonical claims grouped by subject; contested claims flagged with their
// note and never dropped by overflow (hard content, see budget.ts).
export function renderClaimDigest(
  claims: LiveClaimRow[],
  evidence: LiveClaimEvidenceRow[],
  opts: ClaimDigestOptions = FULL_DIGEST,
): string {
  if (claims.length === 0) return "";
  const bySubject = new Map<string, LiveClaimRow[]>();
  for (const c of claims) {
    const list = bySubject.get(c.subjectKey) ?? [];
    list.push(c);
    bySubject.set(c.subjectKey, list);
  }
  const byClaim = new Map<string, LiveClaimEvidenceRow[]>();
  for (const e of evidence) {
    if (!opts.includeContextRelation && e.relation === "context") continue;
    const list = byClaim.get(e.canonicalClaimId) ?? [];
    list.push(e);
    byClaim.set(e.canonicalClaimId, list);
  }
  const lines: string[] = [];
  for (const [subject, subjectClaims] of bySubject) {
    lines.push(`## ${subject}`);
    for (const c of subjectClaims) {
      const flag = c.status === "contested" ? " [CONTESTED]" : "";
      lines.push(`- (${c.predicateKey}, ${c.status})${flag} ${c.statement}`);
      if (c.status === "contested" && c.contestNote) {
        lines.push(`    ! disagreement: ${c.contestNote}`);
      }
      for (const e of pickStrongest(byClaim.get(c.id) ?? [], opts.evidenceK)) {
        lines.push(evidenceLine(e, opts.includeExcerpts));
      }
    }
  }
  return lines.join("\n");
}

// Researcher digest: same renderer, but restricted to claims whose subject
// appears in the task's question (design §12: "its subject only"). Matching is
// deliberately dumb V0.05 code: the subject key's name part (after the type
// prefix) as a lowercase substring of the question.
export function filterClaimsForQuestion(claims: LiveClaimRow[], question: string): LiveClaimRow[] {
  const q = question.toLowerCase();
  return claims.filter((c) => {
    const name = (c.subjectKey.split(":")[1] ?? c.subjectKey).toLowerCase();
    return name.length >= 3 && q.includes(name);
  });
}

// One-paragraph completed-task summaries for stage-≥2 planning. Deterministic
// rendering of the accepted output; never the raw note.
export function summarizeDoneTask(t: DoneTaskRow): TaskResultSummary {
  let summary: string;
  const out = t.output;
  if (out === null) {
    summary = "completed (no accepted output recorded)";
  } else if (typeof out.selfAssessment === "object" && out.selfAssessment !== null) {
    const sa = out.selfAssessment as { complete?: boolean; confidence?: string; gaps?: string[] };
    const gaps = (sa.gaps ?? []).slice(0, 5).join("; ");
    summary = `research ${sa.complete ? "complete" : "incomplete"}, confidence ${sa.confidence ?? "unknown"}${gaps ? `; gaps: ${gaps}` : ""}`;
  } else if (Array.isArray(out.claims)) {
    const contradictions = Array.isArray(out.contradictionsNoticed)
      ? out.contradictionsNoticed.length
      : 0;
    summary = `extracted ${out.claims.length} claims, ${Array.isArray(out.evidence) ? out.evidence.length : 0} evidence items${contradictions ? `, ${contradictions} contradictions noticed` : ""}`;
  } else {
    summary = JSON.stringify(out).slice(0, 300);
  }
  return {
    taskId: t.id,
    title: t.title.slice(0, 500),
    type: t.type,
    summary: summary.slice(0, 1500),
  };
}
