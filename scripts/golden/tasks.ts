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

// The §7 suite. Budget assertion on all four: ≤ $1.50 frontier spend,
// ≤ 45 min wall clock, cycle guard never breached silently. userRequest is
// the question ONLY — never coach the expected behavior into the prompt (the
// vendor rule, contest surfacing, and humanQuestions discipline are what the
// goldens measure).
export const GOLDEN_TASKS: Record<string, GoldenTask> = {
  G1: {
    id: "G1",
    title: "R2 vs B2 vs Garage — comparative research, clean accept",
    userRequest:
      "Compare Cloudflare R2 vs Backblaze B2 vs self-hosted Garage for homelab " +
      "artifact storage",
    expectations: { targetCycles: 1, budgetUsd: 1.5, wallClockMin: 45 },
  },
  G2: {
    id: "G2",
    title: "LiveCodeBench score with a vendor/independent discrepancy — contest + loop",
    // DeepSeek-R1's vendor-reported LiveCodeBench Pass@1 and the rolling
    // independent leaderboard disagree (different problem windows) — the
    // vendor rule must surface the contest, never present one number settled.
    userRequest: "What is DeepSeek-R1's score on the LiveCodeBench benchmark?",
    expectations: { targetCycles: 2, expectContested: true, budgetUsd: 1.5, wallClockMin: 45 },
  },
  G3: {
    id: "G3",
    title: "ECC UDIMM for W680-ACE at 96GB — recency + community evidence",
    userRequest:
      "Best ECC UDIMM kit currently compatible with an ASUS Pro WS W680-ACE " +
      "workstation board at 96GB total",
    expectations: { targetCycles: 1, budgetUsd: 1.5, wallClockMin: 45 },
  },
  G4: {
    id: "G4",
    title: "deliberately ambiguous goal — humanQuestions discipline",
    // The pass state is a scope_ambiguity park, not a confidently wrong plan.
    userRequest: "What's the best storage?",
    expectations: {
      targetCycles: 0,
      expectCheckpoint: "scope_ambiguity",
      budgetUsd: 1.5,
      wallClockMin: 45,
    },
  },
};
