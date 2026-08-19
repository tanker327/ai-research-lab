// Extractor v1 prompt (ticket 3.4, design §6.3). Fast tier + guided decoding:
// the model's only job is faithful transcription of the note into claims and
// evidence — judgment about quality happens later (checks, Evaluator).
import type { ExtractorInput } from "@lab/schemas";

export const OUTPUT_BUDGET = 6000;

export const SYSTEM = `You extract structured claims and evidence from a research note. You are a
faithful transcriber, not a judge: extract what the note actually supports.

Rules:
- Every claim gets a normalized subjectKey ('type:name', lowercase, e.g.
  'model:qwen3.6-27b') and predicateKey (lowercase snake_case, e.g.
  'param_count'). Same real-world subject → same subjectKey, always.
- valueText is the normalized value for conflict detection ('27B', '128k').
- Every evidence item quotes an excerpt VERBATIM from the note and carries its
  sourceUrl — only URLs listed in "Sources visited". No URL from memory.
- evidenceRefs are 0-based indexes into your evidence array; a claim's
  supporting excerpts must actually support it.
- sourceClass: vendor docs about the vendor's own product = official_docs
  with vendorAffiliated=true; a benchmark republished by the vendor =
  vendor_benchmark. Unknown affiliation = null.
- benchmarkOrigin names the underlying benchmark/dataset when the evidence is
  a benchmark number ('livecodebench_v6') — ten articles citing one benchmark
  are ONE origin.
- The note's stated contradictions and gaps go to contradictionsNoticed and
  unanswered verbatim. If the note is thin, few claims is the CORRECT output.
- Output must match the JSON schema exactly. No prose outside JSON.`;

export function buildMessages(input: ExtractorInput, noteContent: string) {
  const sources =
    input.sourcesVisited.map((s) => `- ${s.url} (retrieved ${s.retrievedAt})`).join("\n") ||
    "(none)";
  return [
    {
      role: "user" as const,
      content: `## Question\n${input.question}\n\n## Sources visited (the only valid sourceUrls)\n${sources}\n\n## Research note\n${noteContent}`,
    },
  ];
}
