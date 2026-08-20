// Unit tests for every branch of the §5.4 retry ladder, including boundary
// attempt numbers and the "infra retries don't consume intelligence budget"
// property (phase-1-plan Session A acceptance).
import { CategorizedError, type QualityVerdict, ResearchStrategy } from "@lab/schemas";
import { describe, expect, it } from "vitest";
import { decideRetry, type RetryContext } from "./retry";

const ctx = (over: Partial<RetryContext> = {}): RetryContext => ({
  taskType: "research",
  attemptNumber: 1,
  infraRetryCount: 0,
  strategy: "comparative",
  ...over,
});

const err = (category: ConstructorParameters<typeof CategorizedError>[0]) =>
  new CategorizedError(category, `${category} boom`);

const rejected: QualityVerdict = { rejected: true, reasons: ["thin note"] };

describe("infra backoff", () => {
  it.each([
    [0, 5_000],
    [1, 30_000],
    [2, 120_000],
  ])("retry %i backs off %ims", (infraRetryCount, delayMs) => {
    for (const category of ["TRANSIENT_INFRA", "TOOL_FAILURE"] as const) {
      const v = decideRetry(ctx({ infraRetryCount }), err(category), null);
      expect(v).toMatchObject({ kind: "infra_retry", delayMs });
    }
  });

  it("fails the task after 3 infra retries", () => {
    const v = decideRetry(ctx({ infraRetryCount: 3 }), err("TRANSIENT_INFRA"), null);
    expect(v.kind).toBe("task_failed");
    expect(v.rationale).toContain("backoff");
  });

  it("infra retries do not consume intelligence budget: verdict is independent of attemptNumber", () => {
    for (const attemptNumber of [1, 2, 3, 7]) {
      const v = decideRetry(ctx({ attemptNumber, infraRetryCount: 1 }), err("TOOL_FAILURE"), null);
      expect(v).toMatchObject({ kind: "infra_retry", delayMs: 30_000 });
    }
  });

  it("infra beats a simultaneous quality verdict — the output never ran cleanly", () => {
    const v = decideRetry(ctx(), err("TRANSIENT_INFRA"), rejected);
    expect(v.kind).toBe("infra_retry");
  });
});

describe("schema failure", () => {
  it("re-extracts on extract tasks (never re-research, P8)", () => {
    const v = decideRetry(ctx({ taskType: "extract" }), err("SCHEMA_FAILURE"), null);
    expect(v.kind).toBe("intelligence_retry");
    expect(v.kind === "intelligence_retry" && v.strategy).toBeFalsy();
    expect(v.rationale).toContain("re-extract");
  });

  it("attempt 1 retries at the same configuration (cap-bounded)", () => {
    const v = decideRetry(ctx({ taskType: "research" }), err("SCHEMA_FAILURE"), null);
    expect(v.kind).toBe("intelligence_retry");
    expect(v.kind === "intelligence_retry" && v.tier).toBeFalsy();
    expect(v.rationale).toContain("cheap to retry");
  });

  it("attempt ≥2 escalates to frontier — a deterministic model replays the same bad output", () => {
    const v = decideRetry(
      ctx({ taskType: "analyze", attemptNumber: 2 }),
      err("SCHEMA_FAILURE"),
      null,
    );
    expect(v).toMatchObject({ kind: "intelligence_retry", tier: "frontier" });
    // Extract still never re-researches — but it does remodel.
    const e = decideRetry(
      ctx({ taskType: "extract", attemptNumber: 3 }),
      err("SCHEMA_FAILURE"),
      null,
    );
    expect(e).toMatchObject({ kind: "intelligence_retry", tier: "frontier" });
    expect(e.rationale).toContain("never re-research");
  });
});

describe("quality ladder", () => {
  it("attempt 1 → same tier, fallback strategy from the policy table", () => {
    const v = decideRetry(ctx({ attemptNumber: 1, strategy: "comparative" }), null, rejected);
    expect(v).toMatchObject({ kind: "intelligence_retry", strategy: "primary_sources" });
    expect(v.kind === "intelligence_retry" && v.tier).toBeUndefined();
  });

  it("attempt 1 keeps the strategy when no fallback is mapped", () => {
    const v = decideRetry(ctx({ attemptNumber: 1, strategy: "primary_sources" }), null, rejected);
    expect(v).toMatchObject({ kind: "intelligence_retry", strategy: "primary_sources" });
  });

  it("attempt 1 with no strategy (non-research task) omits it", () => {
    const v = decideRetry(
      ctx({ attemptNumber: 1, strategy: null, taskType: "analyze" }),
      null,
      rejected,
    );
    expect(v.kind).toBe("intelligence_retry");
    expect(v.kind === "intelligence_retry" && v.strategy).toBeUndefined();
  });

  it("attempt 2 → frontier tier escalation", () => {
    const v = decideRetry(ctx({ attemptNumber: 2 }), null, rejected);
    expect(v).toMatchObject({ kind: "intelligence_retry", tier: "frontier" });
  });

  it.each([3, 4])("attempt %i → task_failed (ladder exhausted)", (attemptNumber) => {
    const v = decideRetry(ctx({ attemptNumber }), null, rejected);
    expect(v.kind).toBe("task_failed");
    expect(v.rationale).toContain("exhausted");
  });

  it("every fallback target is a valid ResearchStrategy", () => {
    for (const from of ResearchStrategy.options) {
      const v = decideRetry(ctx({ attemptNumber: 1, strategy: from }), null, rejected);
      expect(v.kind === "intelligence_retry" && v.strategy).toSatisfy((s: unknown) =>
        ResearchStrategy.options.includes(s as ResearchStrategy),
      );
    }
  });

  it("an accepted quality verdict does not retry", () => {
    const v = decideRetry(ctx(), null, { rejected: false, reasons: [] });
    expect(v.kind).toBe("task_failed");
  });
});

describe("non-retryable categories", () => {
  it.each(["PERMANENT_INFRA", "BUDGET_EXCEEDED", "CANCELLED", "MODEL_FAILURE", "UNKNOWN"] as const)(
    "%s → task_failed with the category in the rationale",
    (category) => {
      const v = decideRetry(ctx(), err(category), null);
      expect(v.kind).toBe("task_failed");
      expect(v.rationale).toContain(category);
    },
  );

  it("no error and no verdict → task_failed", () => {
    const v = decideRetry(ctx(), null, null);
    expect(v.kind).toBe("task_failed");
  });
});

describe("rationale", () => {
  it("every verdict carries a non-empty human-readable rationale", () => {
    const cases: Array<[RetryContext, CategorizedError | null, QualityVerdict | null]> = [
      [ctx(), err("TRANSIENT_INFRA"), null],
      [ctx({ infraRetryCount: 3 }), err("TOOL_FAILURE"), null],
      [ctx({ taskType: "extract" }), err("SCHEMA_FAILURE"), null],
      [ctx({ attemptNumber: 1 }), null, rejected],
      [ctx({ attemptNumber: 2 }), null, rejected],
      [ctx({ attemptNumber: 3 }), null, rejected],
      [ctx(), err("PERMANENT_INFRA"), null],
      [ctx(), null, null],
    ];
    for (const [a, e, q] of cases) {
      expect(decideRetry(a, e, q).rationale.length).toBeGreaterThan(20);
    }
  });

  it("quality reasons surface in the rationale for the DecisionRecord", () => {
    const v = decideRetry(ctx(), null, { rejected: true, reasons: ["thin note", "off-target"] });
    expect(v.rationale).toContain("thin note");
    expect(v.rationale).toContain("off-target");
  });
});
