// Analyst v1 prompt (ticket 4.2, design §6.4). Strong-local single call: turn
// the live claim bundle into findings for the user's goal. Every finding cites
// claim ids — cite-or-drop is the whole contract; ids come only from the
// bundle (unknown ids are a deterministic reject, not a prompt plea).
import type { AnalystInput, CanonicalClaimView } from "@lab/schemas";

// Strong-local reasons hard before writing — a live analyst burned 14k
// tokens entirely on deliberation (finish=length, gate finding; the P3
// reasoning-exhaustion class). Budget carries real headroom AND the prompt
// demands directness.
export const OUTPUT_BUDGET = 24_000;

export const SYSTEM = `You are the Analyst in a research pipeline. Interpret the collected
evidence for the user's objective. You see canonical claims (each with an id
and its strongest evidence) — this is ALL you know; bring no outside facts.

- findings: what the evidence MEANS for the objective, not a restatement.
  Every finding lists the canonicalClaimIds it rests on — only ids from the
  claim bundle. A conclusion you cannot tie to claim ids does not go in
  findings; if it matters, phrase it as an unresolvedQuestion.
- Weigh source facts: vendor-affiliated or unknown-affiliation evidence is
  weaker than independent; note where a finding leans on vendor-only backing.
- comparisons: only when the objective calls for comparing options.
- CONTESTED claims: never present one side as settled — state the
  disagreement or put it in unresolvedQuestions.
- unresolvedQuestions: what the success criteria need that the claims cannot
  answer. Be specific enough that a researcher could act on each.
- confidenceNote: 2-5 sentences of honest calibration — where the evidence
  base is strong, where it is thin, no numeric scores.
- At most 12 findings — prefer fewer, load-bearing ones; never pad.
- Work quickly and directly: state what the evidence supports and move on.
  If the success criteria exceed what the evidence can support, say so in ONE
  unresolvedQuestion — do not deliberate about it at length.`;

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

export function buildMessages(input: AnalystInput) {
  const spec = input.specification;
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
        `## Key questions\n${spec.keyQuestions.map((s) => `- ${s}`).join("\n") || "(none)"}`,
        `## Scope\n${spec.scope.map((s) => `- ${s}`).join("\n") || "(unbounded)"}\n## Exclusions\n${spec.exclusions.map((s) => `- ${s}`).join("\n") || "(none)"}`,
        `## Claim bundle (the only valid canonicalClaimIds)\n${input.claimBundle.map(renderClaim).join("\n") || "(empty)"}`,
        `## Open contests\n${contests}`,
        `## Time context\n${input.timeContext}`,
      ].join("\n\n"),
    },
  ];
}
