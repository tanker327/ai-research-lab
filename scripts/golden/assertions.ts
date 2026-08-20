// Pure expectation evaluation for golden runs (phase-8-plan D1/D2): given the
// collected facts of a finished (or parked) run, which assertions failed and
// which soft targets drifted. No I/O — this module is the unit-tested part of
// the runner; run.ts owns the live plumbing.

import type { GoldenExpectations } from "./tasks";

export interface CollectedMetrics {
  evalCycles: number;
  intelligenceRetries: number;
  tierEscalations: number;
  modelCalls: number;
  frontierCalls: number;
  frontierSpendUsd: number | null;
  toolCalls: number;
  liveEvidence: number;
  liveClaims: number;
  contestedClaims: number;
  attemptsTotal: number;
  tasksTotal: number;
  tasksDone: number;
  tasksFailed: number;
  wallClockSeconds: number;
}

export interface CollectedRun {
  runId: string;
  runStatus: string;
  metrics: CollectedMetrics;
  maxEvalCycles: number;
  /** Every checkpoint reason the run raised (pending or resolved). */
  checkpointReasons: string[];
  cycleGuardEvents: number;
  verdicts: Array<{ cycle: number; decision: string; reasons: string[] }>;
  report: { title: string | null; chipCount: number } | null;
}

export interface ExpectationResult {
  /** Hard assertion failures — a non-empty list fails the golden run. */
  failures: string[];
  /** Soft drift vs the reference behavior — recorded in the baseline. */
  divergences: string[];
}

export function evaluateExpectations(exp: GoldenExpectations, c: CollectedRun): ExpectationResult {
  const failures: string[] = [];
  const divergences: string[] = [];

  const spend = c.metrics.frontierSpendUsd ?? 0;
  if (spend > exp.budgetUsd) {
    failures.push(
      `frontier spend $${spend.toFixed(4)} exceeds the $${exp.budgetUsd.toFixed(2)} budget`,
    );
  }

  const wallCapS = exp.wallClockMin * 60;
  if (c.metrics.wallClockSeconds > wallCapS) {
    failures.push(
      `wall clock ${c.metrics.wallClockSeconds}s exceeds the ${exp.wallClockMin}min ceiling`,
    );
  }

  // §7 / plan D3: a breached cycle guard is fine — a SILENT breach is not.
  if (c.metrics.evalCycles >= c.maxEvalCycles && c.cycleGuardEvents === 0) {
    failures.push(
      `eval cycles hit the cap (${c.metrics.evalCycles}/${c.maxEvalCycles}) ` +
        "with no CYCLE_GUARD_TRIPPED event — silent breach",
    );
  }

  if (exp.expectContested && c.metrics.contestedClaims === 0) {
    failures.push("expected ≥1 contested claim; every live claim ended settled");
  }

  if (exp.expectCheckpoint) {
    if (!c.checkpointReasons.includes(exp.expectCheckpoint)) {
      failures.push(
        `expected a '${exp.expectCheckpoint}' checkpoint; saw ` +
          (c.checkpointReasons.length ? `[${c.checkpointReasons.join(", ")}]` : "none"),
      );
    }
    // Parking on the expected checkpoint IS the pass state for this golden.
    if (!["WAITING_HUMAN", "COMPLETED"].includes(c.runStatus)) {
      failures.push(`run ended ${c.runStatus} instead of parking for the expected checkpoint`);
    }
  } else if (c.runStatus !== "COMPLETED") {
    failures.push(`run ended ${c.runStatus}, not COMPLETED`);
  }

  if (!exp.expectCheckpoint && c.runStatus === "COMPLETED" && c.report === null) {
    failures.push("run COMPLETED but no accepted report was retrievable");
  }

  if (c.metrics.evalCycles !== exp.targetCycles) {
    divergences.push(`eval cycles ${c.metrics.evalCycles} vs reference ${exp.targetCycles}`);
  }

  return { failures, divergences };
}

// The committed baseline record (plan D2): the §7 metrics plus the human
// verdict slot. The runner writes verdict "pending"; `--judge` stamps it.
export interface GoldenBaseline {
  goldenId: string;
  title: string;
  date: string; // YYYY-MM-DD (runner-local)
  runId: string;
  runStatus: string;
  expectations: GoldenExpectations;
  metrics: CollectedMetrics;
  maxEvalCycles: number;
  checkpointReasons: string[];
  cycleGuardEvents: number;
  verdicts: Array<{ cycle: number; decision: string; reasons: string[] }>;
  report: { title: string | null; chipCount: number } | null;
  assertionFailures: string[];
  divergences: string[];
  humanVerdict: "pass" | "fail" | "pending";
  humanNote: string | null;
  judgedAt: string | null;
}

export function buildBaseline(args: {
  goldenId: string;
  title: string;
  date: string;
  expectations: GoldenExpectations;
  collected: CollectedRun;
  result: ExpectationResult;
}): GoldenBaseline {
  const { collected: c, result } = args;
  return {
    goldenId: args.goldenId,
    title: args.title,
    date: args.date,
    runId: c.runId,
    runStatus: c.runStatus,
    expectations: args.expectations,
    metrics: c.metrics,
    maxEvalCycles: c.maxEvalCycles,
    checkpointReasons: c.checkpointReasons,
    cycleGuardEvents: c.cycleGuardEvents,
    verdicts: c.verdicts,
    report: c.report,
    assertionFailures: result.failures,
    divergences: result.divergences,
    humanVerdict: "pending",
    humanNote: null,
    judgedAt: null,
  };
}

/** Distinct [cN] citation chips in a report body. */
export function countChips(markdown: string): number {
  const chips = new Set<string>();
  for (const m of markdown.matchAll(/\[c(\d+)\]/g)) chips.add(m[1] as string);
  return chips.size;
}
