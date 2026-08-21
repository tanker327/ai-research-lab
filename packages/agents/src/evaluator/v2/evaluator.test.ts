// Ticket 8.5 contract test: v2 adds per-criterion accountability. The
// deterministic enforcement (missing/unsatisfied verdicts, contested
// unaddressed) lives in @lab/core checks — here we pin the prompt contract
// and the schema round-trip.
import { EvaluatorOutput } from "@lab/schemas";
import { describe, expect, it } from "vitest";
import { evaluatorV2 } from "./index";
import { SYSTEM } from "./prompt";

describe("evaluatorV2", () => {
  it("reports version v2 and shares the EvaluatorOutput contract", () => {
    expect(evaluatorV2.version).toBe("v2");
    expect(evaluatorV2.outputSchema).toBe(EvaluatorOutput);
  });

  it("criterionVerdicts round-trips and defaults to [] for v1-era outputs", () => {
    const parsed = EvaluatorOutput.parse({
      decision: "ACCEPT",
      reasons: ["ok"],
      criterionVerdicts: [{ criterion: "cite official docs", verdict: "satisfied", pointer: "c1" }],
    });
    expect(parsed.criterionVerdicts[0]?.verdict).toBe("satisfied");
    expect(EvaluatorOutput.parse({ decision: "STOP", reasons: ["r"] }).criterionVerdicts).toEqual(
      [],
    );
  });

  it("prompt demands one verbatim verdict per criterion and forbids satisfied-without-pointer", () => {
    expect(SYSTEM).toContain("criterionVerdicts");
    expect(SYSTEM).toContain("not_assessable");
    expect(SYSTEM).toContain("Never mark satisfied without a pointer");
    expect(SYSTEM).toContain("Vendor-only sourcing");
    expect(SYSTEM).toContain("CONTESTED claims");
  });
});
