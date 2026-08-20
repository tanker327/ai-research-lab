// Synthesizer v1 prompt (ticket 5.1, design §6.6/§24.4). One frontier call:
// turn the approved analysis + live claims into the final report. NO tools —
// the Synthesizer cannot import facts (§18); every sentence must rest on a
// cited claim, enforced by the deterministic validator (5.2, ADR-020), not by
// this prompt alone.
import type { CanonicalClaimView, SynthesizerInput } from "@lab/schemas";

// The report is prose, not reasoning — but frontier reasoning models still
// deliberate before writing (the P3/P4 exhaustion class). Real headroom.
export const OUTPUT_BUDGET = 24_000;

export const SYSTEM = `You are the Synthesizer in a research pipeline: you write the FINAL
REPORT from approved material only. You see the accepted analysis and the
canonical claim bundle — this is ALL you know; bring no outside facts.

CITATIONS (mechanically validated — violations reject your output):
- Write citation chips inline as [c1], [c2], … at the end of each sentence
  they support. Every sentence in the report body must carry at least one
  chip. A sentence you cannot back with claim ids does not belong in the
  report.
- citationMap maps each chip id (e.g. "c1") to the canonical claim ids it
  cites — ONLY ids from the claim bundle. Every chip used in the text must
  appear in the map; every map entry must be used in the text.
- CONTESTED claims may only be cited inside the "## Uncertainties" section,
  where the disagreement is stated.

STRUCTURE (markdown):
- Start with a one-paragraph executive summary (cited like everything else).
- Body sections as the material warrants (findings, comparisons — follow the
  analysis, do not invent new conclusions).
- End with "## Uncertainties": reproduce EVERY accepted uncertainty you were
  given, verbatim or faithfully restated, plus any contested claims. These
  sentences are exempt from the chip requirement (chips still allowed).
- No heading needs a chip; every other sentence does.

STYLE: direct, specific, decision-ready prose for the person who asked the
question. State numbers and sources' character (vendor vs independent) where
the analysis weighed them. Never pad. Write the report in ONE pass — do not
deliberate at length before writing.`;

function renderClaim(c: CanonicalClaimView): string {
  const lines = [
    `- id=${c.id} (${c.subjectKey} · ${c.predicateKey}, ${c.status})${c.status === "contested" ? " [CONTESTED]" : ""} ${c.statement}`,
  ];
  if (c.contestNote) lines.push(`    ! disagreement: ${c.contestNote}`);
  for (const e of c.evidence) {
    const bits = [
      e.relation,
      e.sourceClass,
      e.vendorAffiliated === true ? "vendor-affiliated" : null,
      e.vendorAffiliated === null ? "affiliation-unknown" : null,
      e.benchmarkOrigin ? `benchmark:${e.benchmarkOrigin}` : null,
      e.sourceUrl,
    ].filter(Boolean);
    lines.push(`    · [${bits.join(", ")}] "${e.excerpt.slice(0, 300)}"`);
  }
  return lines.join("\n");
}

export function buildMessages(input: SynthesizerInput) {
  const spec = input.specification;
  const a = input.analysis;
  const cite = (ids: string[]) => ids.join(", ");
  const contests =
    input.openContests
      .map((c) => `- claim ${c.claimId}: ${c.statement}\n  disagreement: ${c.contestNote}`)
      .join("\n") || "(none)";
  return [
    {
      role: "user" as const,
      content: [
        `## Objective\n${spec.objective}`,
        `## Success criteria\n${spec.successCriteria.map((s) => `- ${s}`).join("\n") || "(none)"}`,
        `## Scope\n${spec.scope.map((s) => `- ${s}`).join("\n") || "(unbounded)"}\n## Exclusions\n${spec.exclusions.map((s) => `- ${s}`).join("\n") || "(none)"}`,
        `## Approved analysis\n### Findings\n${a.findings.map((f) => `- ${f.statement} [claims: ${cite(f.canonicalClaimIds)}]${f.implication ? `\n  → ${f.implication}` : ""}`).join("\n")}`,
        a.comparisons.length
          ? `### Comparisons\n${a.comparisons.map((c) => `- ${c.topic}: ${c.statement} [claims: ${cite(c.canonicalClaimIds)}]`).join("\n")}`
          : "",
        `### Analyst confidence\n${a.confidenceNote}`,
        `## Accepted uncertainties (MUST all appear in ## Uncertainties)\n${input.acceptedUncertainties.map((u) => `- ${u}`).join("\n") || "(none)"}`,
        `## Claim bundle (the only valid claim ids for citationMap)\n${input.claimBundle.map(renderClaim).join("\n") || "(empty)"}`,
        `## Open contests\n${contests}`,
        `## Time context\n${input.timeContext}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ];
}
