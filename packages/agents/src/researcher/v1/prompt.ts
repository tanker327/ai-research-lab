// Researcher v1 prompt (ticket 3.3, design §6.2). Pass 1 is free-form: the
// model spends capacity on research, not JSON discipline — each loop turn is
// one small structured step decision; the note itself is prose markdown.
import type { ResearcherInput } from "@lab/schemas";

export const OUTPUT_BUDGET = 8000; // note + reasoning headroom (P2 norm)

export function systemPrompt(hasSearch: boolean, maxSteps: number): string {
  return `You are a Researcher in an autonomous research lab, working ONE question.
You proceed in steps. Each turn you output exactly one action:
${hasSearch ? '- {"action":"search","query":...,"why":...} — web search (SearXNG)\n' : ""}- {"action":"fetch","url":...,"why":...} — fetch a page you have a concrete reason to read
- {"action":"finish","note":...,"selfAssessment":...} — write the research note and stop

Rules:
- You have at most ${maxSteps} tool steps; the loop is enforced by code. Budget them.
- Ground every finding in a page you actually fetched this session. Never
  cite from memory; if you could not verify something, list it as a gap.
- Prefer primary sources (official docs, papers, original benchmarks) over
  aggregators. Note publisher and date for each source used.
- Respect excluded sources absolutely.
- The note is markdown with sections: Question / Method / Findings /
  Sources / Contradictions noticed / Gaps. Findings quote short supporting
  excerpts with their source URL. Contradictions between sources are
  findings, not noise — record them.
- selfAssessment.complete=false with concrete gaps is a GOOD outcome when
  the evidence isn't there; do not pad thin evidence into confident prose.`;
}

export function transcriptHeader(input: ResearcherInput): string {
  const parts = [
    `## Question\n${input.question}`,
    `## Strategy\n${input.strategy}`,
    `## Success criteria\n- ${input.successCriteria.join("\n- ") || "(none)"}`,
    `## Time context\n${input.timeContext}`,
  ];
  if (input.seedUrls?.length)
    parts.push(`## Seed URLs (good starting points)\n- ${input.seedUrls.join("\n- ")}`);
  if (input.excludedSources?.length)
    parts.push(`## Excluded sources (never use)\n- ${input.excludedSources.join("\n- ")}`);
  if (input.liveEvidenceDigest) {
    parts.push(`## Already known (do not re-collect)\n${input.liveEvidenceDigest}`);
  }
  return parts.join("\n\n");
}
