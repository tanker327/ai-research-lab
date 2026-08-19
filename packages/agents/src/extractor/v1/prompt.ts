// Extractor v1 prompt (ticket 3.4, design §6.3). Fast tier + guided decoding:
// the model's only job is faithful transcription of the note into claims and
// evidence — judgment about quality happens later (checks, Evaluator).
import type { ExtractorInput } from "@lab/schemas";

// deepseek-v4-flash thinks ~3k tokens before answering (gate finding) — the
// JSON needs real headroom on top (P2 norm).
export const OUTPUT_BUDGET = 16_000;

// Deliberately TERSE (gate finding): a rule-heavy system prompt sent the
// fast reasoning model into 14k tokens of deliberation with zero output.
export const SYSTEM = `Extract claims and evidence from the research note into the given JSON
schema. Work quickly and directly — transcribe what the note supports, do not
deliberate.

- subjectKey: 'type:name', lowercase ('db:postgresql'); predicateKey:
  lowercase snake_case ('transactional_ddl'). Same subject → same key.
- valueText: short normalized value for conflict detection ('supported', '27B').
- Evidence excerpts are VERBATIM quotes from the note (max ~2 sentences),
  sourceUrl only from "Sources visited". No URLs from memory.
- evidenceRefs: 0-based indexes into your evidence array.
- vendorAffiliated: true when the source is the subject's own vendor/project;
  null when unknown. benchmarkOrigin only for benchmark numbers.
- AT MOST the 12 most important claims and 15 evidence items — prefer fewer,
  stronger items; never pad. Few claims from a thin note is correct.
- Copy the note's contradictions and open questions into
  contradictionsNoticed / unanswered.`;

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
