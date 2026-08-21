// Analyst v2 prompt (ticket 8.4, phase-8 D6). v1 + two hardenings from the
// first G1 baseline: (a) renders schemaFeedback — why the previous attempt of
// this task failed schema validation or hit the output budget — so a retry is
// a fix, not a temp-0 verbatim replay; (b) explicit id discipline (a live
// frontier attempt failed Zod by gluing two UUIDs into one canonicalClaimIds
// string) and a standing conciseness rule (strong_local hit finish=length at
// 24k over an 86-claim bundle). v1 is frozen — it has accepted attempts
// (design §33).
import type { AnalystInput, CanonicalClaimView } from "@lab/schemas";

export const OUTPUT_BUDGET = 24_000;

export const SYSTEM = `You are the Analyst in a research pipeline. Interpret the collected
evidence for the user's objective. You see canonical claims (each with an id
and its strongest evidence) — this is ALL you know; bring no outside facts.

- findings: what the evidence MEANS for the objective, not a restatement.
  Every finding lists the canonicalClaimIds it rests on — only ids from the
  claim bundle. Each canonicalClaimIds entry is EXACTLY ONE id, copied
  verbatim from the bundle — never join two ids in one string, never invent
  or abbreviate an id. A conclusion you cannot tie to claim ids does not go
  in findings; if it matters, phrase it as an unresolvedQuestion.
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
- Your entire output must fit a fixed token budget. On large claim bundles,
  keep statements tight and cite ids instead of restating claim text.
- Work quickly and directly: state what the evidence supports and move on.
  If the success criteria exceed what the evidence can support, say so in ONE
  unresolvedQuestion — do not deliberate about it at length.
- If "Previous attempt failed" feedback is present, it is the single most
  important instruction: correct exactly what it names.`;

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
  const sections = [
    `## Objective\n${spec.objective}`,
    `## Success criteria\n${spec.successCriteria.map((s) => `- ${s}`).join("\n") || "(none)"}`,
    `## Key questions\n${spec.keyQuestions.map((s) => `- ${s}`).join("\n") || "(none)"}`,
    `## Scope\n${spec.scope.map((s) => `- ${s}`).join("\n") || "(unbounded)"}\n## Exclusions\n${spec.exclusions.map((s) => `- ${s}`).join("\n") || "(none)"}`,
    `## Claim bundle (the only valid canonicalClaimIds)\n${input.claimBundle.map(renderClaim).join("\n") || "(empty)"}`,
    `## Open contests\n${contests}`,
    `## Time context\n${input.timeContext}`,
  ];
  if (input.schemaFeedback.length > 0) {
    sections.push(
      `## Previous attempt failed — fix this\n${input.schemaFeedback.map((f) => `- ${f}`).join("\n")}`,
    );
  }
  return [{ role: "user" as const, content: sections.join("\n\n") }];
}
