// Ticket 5.2 unit matrix (ADR-020, phase-5-plan D3): the citation validator
// is pure code — every rule exercised without a database or a model.
import type { SynthesizerOutput } from "@lab/schemas";
import { describe, expect, it } from "vitest";
import { type CitableClaim, splitSentences, synthesizerPreAcceptChecks } from "./citations";

const CLAIMS = new Map<string, CitableClaim>([
  ["claim-1", { status: "supported", liveEvidenceCount: 2 }],
  ["claim-2", { status: "proposed", liveEvidenceCount: 1 }],
  ["claim-c", { status: "contested", liveEvidenceCount: 1 }],
  ["claim-r", { status: "rejected", liveEvidenceCount: 1 }],
  ["claim-0", { status: "supported", liveEvidenceCount: 0 }],
]);

const GOOD: SynthesizerOutput = {
  title: "Report",
  reportMarkdown: [
    "# Findings report",
    "",
    "The first claim holds under load. [c1]",
    "",
    "## Details",
    "- The second claim is confirmed by an independent source. [c2]",
    "- Both effects compose cleanly. [c1][c2]",
    "",
    "## Uncertainties",
    "- Community reports were not exhaustively sampled.",
    "- The context-window figure is disputed between docs and users. [c3]",
  ].join("\n"),
  citationMap: { c1: ["claim-1"], c2: ["claim-2"], c3: ["claim-c"] },
};

function checksFor(
  md: string,
  map: SynthesizerOutput["citationMap"],
  uncertainties: string[] = [],
) {
  return synthesizerPreAcceptChecks(
    { title: "t", reportMarkdown: md, citationMap: map },
    CLAIMS,
    uncertainties,
  );
}

describe("splitSentences", () => {
  it("skips headings and code fences, strips list markers, tracks the Uncertainties section", () => {
    const s = splitSentences(GOOD.reportMarkdown);
    expect(s.every((x) => !x.text.startsWith("#"))).toBe(true);
    expect(s.filter((x) => x.inUncertainties)).toHaveLength(2);
    const fenced = splitSentences("```\nuncited code line\n```\nCited prose. [c1]");
    expect(fenced).toHaveLength(1);
  });

  it("keeps trailing chips attached to their sentence when splitting", () => {
    const s = splitSentences("A holds. [c1] B holds. [c2]");
    expect(s).toHaveLength(2);
    expect(s[0]?.chips).toEqual(["c1"]);
    expect(s[1]?.chips).toEqual(["c2"]);
  });
});

describe("synthesizerPreAcceptChecks", () => {
  it("clean report passes with zero failures", () => {
    expect(
      synthesizerPreAcceptChecks(GOOD, CLAIMS, ["community reports not exhaustively sampled"]),
    ).toEqual([]);
  });

  it("uncited body sentence → reject (ADR-020: uncitedFactualSentences must be 0)", () => {
    const f = checksFor("This sentence has no chip.\n\nThis one does. [c1]", { c1: ["claim-1"] });
    expect(f.map((x) => x.check)).toEqual(["check:uncited_sentences"]);
    expect(f[0]?.reason).toContain("no chip");
    expect(f[0]?.severity).toBe("reject");
  });

  it("chip in text missing from the map, and unused map entry, both reject", () => {
    const f = checksFor("Cited. [c9]", { c1: ["claim-1"] });
    expect(f.map((x) => x.check).sort()).toEqual([
      "check:unknown_chips",
      "check:unused_map_entries",
    ]);
  });

  it("chip resolving to a dead claim (unknown / rejected / zero live evidence) rejects", () => {
    for (const bad of ["nope", "claim-r", "claim-0"]) {
      const f = checksFor("Cited. [c1]", { c1: [bad] });
      expect(f.map((x) => x.check)).toContain("check:chips_cite_live_claims");
    }
  });

  it("contested claim cited outside Uncertainties rejects; inside is allowed", () => {
    const outside = checksFor("Settled fact. [c1]", { c1: ["claim-c"] });
    expect(outside.map((x) => x.check)).toContain("check:contested_outside_uncertainties");
    const inside = checksFor("## Uncertainties\n- Disputed figure. [c1]", { c1: ["claim-c"] });
    expect(inside).toEqual([]);
  });

  it("accepted uncertainties without a matching Uncertainties section reject", () => {
    const f = checksFor("All good. [c1]", { c1: ["claim-1"] }, ["gap A", "gap B"]);
    expect(f.map((x) => x.check)).toContain("check:uncertainties_reproduced");
    // A section with enough entries satisfies the promise.
    const ok = checksFor(
      "All good. [c1]\n\n## Uncertainties\n- gap A restated.\n- gap B restated.",
      { c1: ["claim-1"] },
      ["gap A", "gap B"],
    );
    expect(ok).toEqual([]);
  });
});
