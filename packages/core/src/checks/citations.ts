// Deterministic citation validator (ticket 5.2, ADR-020, phase-5-plan D3).
// Code, not model: structure decides, never semantics. Every sentence in the
// report body outside the Uncertainties section must carry ≥1 [cN] chip;
// every chip must resolve through the citationMap to a live, citable claim
// with live evidence. Violations REJECT the attempt onto the ordinary quality
// ladder (ADR-010) — synthesis cannot introduce unprovenanced statements by
// construction.
//
// §24.4 says chips resolve to an "APPROVED" claim; no workflow state ever
// stamps 'approved' (claims live as proposed/supported/contested). The
// enforced interpretation: LIVE and not 'rejected'; 'contested' claims are
// citable ONLY from the Uncertainties section (recorded in phase-5-plan
// findings).
import type { SynthesizerOutput } from "@lab/schemas";
import type { CheckFailure } from "./index";

export interface CitableClaim {
  status: string; // canonical_claims.status
  liveEvidenceCount: number;
}

const CHIP = /\[(c\d+)\]/g;
const HEADING = /^#{1,6}\s+(.*)$/;
const UNCERTAINTIES = /^uncertaint/i;
const LIST_MARKER = /^(?:[-*+]|\d+\.)\s+/;

interface Sentence {
  text: string;
  chips: string[];
  inUncertainties: boolean;
}

// Deterministic markdown walk: headings switch sections, fenced code is
// skipped, list markers are stripped, lines split on terminal punctuation.
// A "sentence" is any segment with ≥1 letter — if the Synthesizer wants to
// say it, it cites it (D3: no content-based factualness judgment).
export function splitSentences(markdown: string): Sentence[] {
  const out: Sentence[] = [];
  let inUncertainties = false;
  let inFence = false;
  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence || line === "") continue;
    const heading = HEADING.exec(line);
    if (heading) {
      inUncertainties = UNCERTAINTIES.test((heading[1] ?? "").trim());
      continue;
    }
    const body = line.replace(LIST_MARKER, "");
    // Split after . ! ? (optionally followed by closing quotes/parens and a
    // trailing chip cluster) — chips stay attached to the sentence they end.
    const segments = body
      .split(/(?<=[.!?]["')\]]*(?:\s*\[c\d+\])*)\s+(?!\[c\d+\])/)
      .map((s) => s.trim())
      .filter((s) => /\p{L}/u.test(s));
    for (const text of segments) {
      const chips = [...text.matchAll(CHIP)].map((m) => m[1] as string);
      out.push({ text, chips, inUncertainties });
    }
  }
  return out;
}

export function synthesizerPreAcceptChecks(
  output: SynthesizerOutput,
  claims: ReadonlyMap<string, CitableClaim>,
  acceptedUncertainties: readonly string[],
): CheckFailure[] {
  const failures: CheckFailure[] = [];
  const sentences = splitSentences(output.reportMarkdown);
  const clip = (s: string) => (s.length > 120 ? `${s.slice(0, 120)}…` : s);

  // 1. Every body sentence outside Uncertainties carries ≥1 chip (ADR-020:
  //    uncitedFactualSentences must equal 0).
  const uncited = sentences.filter((s) => !s.inUncertainties && s.chips.length === 0);
  if (uncited.length > 0) {
    failures.push({
      check: "check:uncited_sentences",
      reason: `${uncited.length} uncited sentence(s) in the report body — every sentence outside ## Uncertainties must end with a citation chip. First: "${clip(uncited[0]?.text ?? "")}"`,
      severity: "reject",
    });
  }

  // 2. Chip↔map integrity: every chip in the text resolves; every map entry
  //    is used. An orphan on either side is a fabrication vector.
  const chipsInText = new Set(sentences.flatMap((s) => s.chips));
  const mapKeys = new Set(Object.keys(output.citationMap));
  const unknownChips = [...chipsInText].filter((c) => !mapKeys.has(c));
  if (unknownChips.length > 0) {
    failures.push({
      check: "check:unknown_chips",
      reason: `chip(s) used in the text but missing from citationMap: ${unknownChips.slice(0, 5).join(", ")}${unknownChips.length > 5 ? ", …" : ""}`,
      severity: "reject",
    });
  }
  const unusedKeys = [...mapKeys].filter((k) => !chipsInText.has(k));
  if (unusedKeys.length > 0) {
    failures.push({
      check: "check:unused_map_entries",
      reason: `citationMap entries never used in the text: ${unusedKeys.slice(0, 5).join(", ")}${unusedKeys.length > 5 ? ", …" : ""}`,
      severity: "reject",
    });
  }

  // 3. Every cited claim id is a LIVE claim with ≥1 live evidence link and a
  //    citable status ('rejected' is never citable).
  const badIds: string[] = [];
  for (const ids of Object.values(output.citationMap)) {
    for (const id of ids) {
      const claim = claims.get(id);
      if (!claim || claim.status === "rejected" || claim.liveEvidenceCount === 0) {
        badIds.push(id);
      }
    }
  }
  if (badIds.length > 0) {
    const unique = [...new Set(badIds)];
    failures.push({
      check: "check:chips_cite_live_claims",
      reason: `citationMap cites ${unique.length} id(s) that are not live evidence-backed claims: ${unique.slice(0, 5).join(", ")}${unique.length > 5 ? ", …" : ""}`,
      severity: "reject",
    });
  }

  // 4. Contested claims are citable ONLY from the Uncertainties section,
  //    where the disagreement is stated (D3.5).
  const contestedIds = new Set(
    [...claims.entries()].filter(([, c]) => c.status === "contested").map(([id]) => id),
  );
  const contestedOutside = sentences
    .filter((s) => !s.inUncertainties)
    .flatMap((s) => s.chips)
    .filter((chip) => (output.citationMap[chip] ?? []).some((id) => contestedIds.has(id)));
  if (contestedOutside.length > 0) {
    failures.push({
      check: "check:contested_outside_uncertainties",
      reason: `chip(s) citing CONTESTED claims outside ## Uncertainties: ${[...new Set(contestedOutside)].slice(0, 5).join(", ")} — a contested claim may never read as settled`,
      severity: "reject",
    });
  }

  // 5. Accepted uncertainties are a promise to the user (§6.6): when the
  //    verdict carried any, the report needs an Uncertainties section with at
  //    least as many entries. (Verbatim matching would punish faithful
  //    restating — count is the deterministic proxy.)
  if (acceptedUncertainties.length > 0) {
    const entries = sentences.filter((s) => s.inUncertainties).length;
    if (entries < acceptedUncertainties.length) {
      failures.push({
        check: "check:uncertainties_reproduced",
        reason: `the final verdict accepted ${acceptedUncertainties.length} uncertaint(ies) but the ## Uncertainties section has ${entries} entr(ies) — every accepted uncertainty must appear`,
        severity: "reject",
      });
    }
  }

  return failures;
}
