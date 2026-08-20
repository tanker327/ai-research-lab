// Golden research tasks as DATA (phase-8-plan D1): the runner is one program;
// what varies per golden is only this table. Definitions are the §7 tasks
// verbatim with their expectations encoded — ticket 8.2 fills G1–G4.
//
// Expectation semantics (see assertions.ts):
//   hard (runner exit code): budgetUsd, wallClockMin, expectContested,
//     expectCheckpoint, and "cycle guard never breached silently";
//   soft (recorded divergence, reviewed via the baseline diff): targetCycles —
//     live runs are nondeterministic, so cycle drift is a finding, not a crash.

export interface GoldenExpectations {
  /** Eval cycles the reference behavior takes (soft — divergence, not failure). */
  targetCycles: number;
  /** ≥1 live claim must end contested (never presented settled). */
  expectContested?: boolean;
  /** The run must park at a checkpoint with this reason instead of completing. */
  expectCheckpoint?: string;
  /** Frontier spend ceiling for the whole run (hard). */
  budgetUsd: number;
  /** Wall-clock ceiling in minutes (hard; also the runner's wait timeout). */
  wallClockMin: number;
}

export interface GoldenTask {
  id: string;
  title: string;
  userRequest: string;
  expectations: GoldenExpectations;
}

export const GOLDEN_TASKS: Record<string, GoldenTask> = {};
