// Synthesis accept (ticket 5.1, phase-5-plan D4). An ACCEPTED synthesize
// attempt is the run's finish line: SYNTHESIZING → COMPLETED in the same
// transaction. The deterministic citation validator (5.2, ADR-020) runs as a
// pre-accept check in the evaluation sweep — by the time this module sees the
// attempt, every chip resolves; this module only lands the state change.
// Fake-handler synthesize tasks (gates, phase-1 chains) have no
// SynthesizerOutput — they complete the run plainly so the walk machinery
// stays exercised end to end.
import {
  type Db,
  type EvaluationCandidate,
  getRunForUpdate,
  selectAttemptOutput,
  updateRunStatus,
} from "@lab/db";
import { SynthesizerOutput } from "@lab/schemas";
import { emitEvent } from "./events";
import { acceptAttemptInTx } from "./liveness";
import { assertRunTransition } from "./state/run";

const ACTOR = "run_coordinator";

export interface SynthesisAcceptance {
  completed: boolean; // false only when the run was not in SYNTHESIZING (legacy)
  hasReport: boolean; // false for fake-handler outputs
}

export async function acceptSynthesisAttempt(
  db: Db,
  c: EvaluationCandidate,
): Promise<SynthesisAcceptance> {
  return db.transaction(async (tx) => {
    await acceptAttemptInTx(tx, c.attemptId, ACTOR);

    const parsed = SynthesizerOutput.safeParse(await selectAttemptOutput(tx, c.attemptId));
    const hasReport = parsed.success;
    if (hasReport) {
      await emitEvent(tx, {
        runId: c.runId,
        taskId: c.taskId,
        attemptId: c.attemptId,
        type: "REPORT_ACCEPTED",
        kind: "gate", // frontier judgment point (§24.3)
        actor: ACTOR,
        payload: {
          title: parsed.data.title,
          chips: Object.keys(parsed.data.citationMap).length,
        },
      });
    } else {
      await emitEvent(tx, {
        runId: c.runId,
        taskId: c.taskId,
        attemptId: c.attemptId,
        type: "REPORT_SKIPPED",
        kind: "info",
        actor: ACTOR,
        payload: { reason: "attempt output is not a SynthesizerOutput" },
      });
    }

    const run = await getRunForUpdate(tx, c.runId);
    if (run?.status !== "SYNTHESIZING") return { completed: false, hasReport };
    assertRunTransition("SYNTHESIZING", "COMPLETED");
    await updateRunStatus(tx, c.runId, "COMPLETED");
    await emitEvent(tx, {
      runId: c.runId,
      type: "RUN_COMPLETED",
      kind: "accept",
      actor: ACTOR,
      payload: { from: "SYNTHESIZING", to: "COMPLETED" },
    });
    return { completed: true, hasReport };
  });
}
