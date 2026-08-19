// Deterministic cycle guard (ADR-016): code, not prompt, stops evaluation
// loops. The counter lives in research_runs.eval_cycle_count; this verdict is
// what the Phase-4 coordinator consults before opening another eval cycle.
export interface CycleGuardVerdict {
  exceeded: boolean;
  rationale: string;
}

export function checkCycleGuard(evalCycleCount: number, maxEvalCycles: number): CycleGuardVerdict {
  if (evalCycleCount >= maxEvalCycles) {
    return {
      exceeded: true,
      rationale: `eval cycle ${evalCycleCount} reached the hard cap of ${maxEvalCycles} (ADR-016): no further evaluation loops — escalate to WAITING_HUMAN or fail the run.`,
    };
  }
  return {
    exceeded: false,
    rationale: `eval cycle ${evalCycleCount} of ${maxEvalCycles} — loop may continue.`,
  };
}
