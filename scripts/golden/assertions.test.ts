// Unit coverage for the golden runner's pure parts (phase-8-plan test plan):
// expectation evaluation against collected-run fixtures and baseline
// serialization. No live calls, no DB.
import { describe, expect, it } from "vitest";
import {
  buildBaseline,
  type CollectedMetrics,
  type CollectedRun,
  countChips,
  evaluateExpectations,
} from "./assertions";
import type { GoldenExpectations } from "./tasks";

const exp = (over: Partial<GoldenExpectations> = {}): GoldenExpectations => ({
  targetCycles: 1,
  budgetUsd: 1.5,
  wallClockMin: 45,
  ...over,
});

type CollectedOverride = Partial<Omit<CollectedRun, "metrics">> & {
  metrics?: Partial<CollectedMetrics>;
};

const collected = (over: CollectedOverride = {}): CollectedRun => {
  const { metrics, ...rest } = over;
  return {
    runId: "run-1",
    runStatus: "COMPLETED",
    metrics: {
      evalCycles: 1,
      intelligenceRetries: 0,
      tierEscalations: 0,
      modelCalls: 10,
      frontierCalls: 2,
      frontierSpendUsd: 0.42,
      toolCalls: 6,
      liveEvidence: 8,
      liveClaims: 12,
      contestedClaims: 0,
      attemptsTotal: 9,
      tasksTotal: 7,
      tasksDone: 7,
      tasksFailed: 0,
      wallClockSeconds: 600,
      ...metrics,
    },
    maxEvalCycles: 3,
    checkpointReasons: [],
    cycleGuardEvents: 0,
    verdicts: [{ cycle: 1, decision: "ACCEPT", reasons: [] }],
    report: { title: "Fixture Report", chipCount: 9 },
    ...rest,
  };
};

describe("evaluateExpectations", () => {
  it("passes a clean completed run on target", () => {
    const r = evaluateExpectations(exp(), collected());
    expect(r.failures).toEqual([]);
    expect(r.divergences).toEqual([]);
  });

  it("fails on frontier overspend and wall-clock breach", () => {
    const r = evaluateExpectations(
      exp({ budgetUsd: 0.25, wallClockMin: 5 }),
      collected({ metrics: { frontierSpendUsd: 0.9, wallClockSeconds: 400 } }),
    );
    expect(r.failures).toHaveLength(2);
    expect(r.failures[0]).toContain("budget");
    expect(r.failures[1]).toContain("wall clock");
  });

  it("treats null frontier spend as zero", () => {
    const r = evaluateExpectations(exp(), collected({ metrics: { frontierSpendUsd: null } }));
    expect(r.failures).toEqual([]);
  });

  it("flags a SILENT cycle-guard breach, but not an evented one", () => {
    const capped = collected({
      metrics: { evalCycles: 3 },
      verdicts: [],
    });
    const silent = evaluateExpectations(exp({ targetCycles: 3 }), capped);
    expect(silent.failures.some((f) => f.includes("silent breach"))).toBe(true);

    const evented = evaluateExpectations(
      exp({ targetCycles: 3 }),
      collected({
        metrics: { evalCycles: 3 },
        cycleGuardEvents: 1,
        runStatus: "WAITING_HUMAN",
      }),
    );
    expect(evented.failures.some((f) => f.includes("silent breach"))).toBe(false);
  });

  it("fails when an expected contested claim never surfaced", () => {
    const r = evaluateExpectations(exp({ expectContested: true }), collected());
    expect(r.failures.some((f) => f.includes("contested"))).toBe(true);
    const ok = evaluateExpectations(
      exp({ expectContested: true }),
      collected({ metrics: { contestedClaims: 2 } }),
    );
    expect(ok.failures).toEqual([]);
  });

  it("expectCheckpoint: parking at the expected reason passes; completing without it fails", () => {
    const parked = evaluateExpectations(
      exp({ expectCheckpoint: "scope_ambiguity" }),
      collected({
        runStatus: "WAITING_HUMAN",
        checkpointReasons: ["scope_ambiguity"],
        report: null,
      }),
    );
    expect(parked.failures).toEqual([]);

    const confidentGuess = evaluateExpectations(
      exp({ expectCheckpoint: "scope_ambiguity" }),
      collected(), // completed, never asked
    );
    expect(confidentGuess.failures.some((f) => f.includes("scope_ambiguity"))).toBe(true);
  });

  it("a run that dies is a failure, and a completed run must have a report", () => {
    const dead = evaluateExpectations(exp(), collected({ runStatus: "FAILED", report: null }));
    expect(dead.failures.some((f) => f.includes("FAILED"))).toBe(true);
    const reportless = evaluateExpectations(exp(), collected({ report: null }));
    expect(reportless.failures.some((f) => f.includes("no accepted report"))).toBe(true);
  });

  it("cycle drift is a divergence, not a failure", () => {
    const r = evaluateExpectations(exp({ targetCycles: 2 }), collected());
    expect(r.failures).toEqual([]);
    expect(r.divergences).toEqual(["eval cycles 1 vs reference 2"]);
  });
});

describe("buildBaseline", () => {
  it("serializes the §7 record with a pending human verdict", () => {
    const c = collected();
    const b = buildBaseline({
      goldenId: "G1",
      title: "fixture golden",
      date: "2026-08-20",
      expectations: exp(),
      collected: c,
      result: { failures: [], divergences: ["eval cycles 1 vs reference 2"] },
    });
    expect(b).toMatchObject({
      goldenId: "G1",
      runId: "run-1",
      humanVerdict: "pending",
      humanNote: null,
      judgedAt: null,
      divergences: ["eval cycles 1 vs reference 2"],
    });
    expect(b.metrics.frontierSpendUsd).toBe(0.42);
    // Round-trips as plain JSON (what gets committed).
    expect(JSON.parse(JSON.stringify(b))).toEqual(b);
  });
});

describe("countChips", () => {
  it("counts DISTINCT chips only, ignoring non-chip brackets", () => {
    expect(countChips("A claim [c1][c2]. Another [c1]. See [note] and [c10].")).toBe(3);
    expect(countChips("no chips here")).toBe(0);
  });
});
