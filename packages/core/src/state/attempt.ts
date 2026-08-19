// Attempt state machine (design §8.4, liveness §5.3/ADR-014).
//
// SUCCEEDED/FAILED/REJECTED can all be SUPERSEDED — that is exactly the set the
// §5.3 accept transaction retires, so this table must let the event-log replay
// of an accept pass assertTransition. ACCEPTED is terminal for now: nothing in
// Phase 1 re-runs a DONE task, and idx_attempts_one_accepted enforces the
// single-live-attempt invariant at the SQL layer.
import type { AttemptStatus } from "@lab/schemas";
import { defineMachine } from "./machine";

export const ATTEMPT_TRANSITIONS: Readonly<Record<AttemptStatus, readonly AttemptStatus[]>> = {
  CREATED: ["RUNNING", "CANCELLED"],
  RUNNING: ["SUCCEEDED", "FAILED", "CANCELLED"],
  SUCCEEDED: ["ACCEPTED", "REJECTED", "SUPERSEDED", "CANCELLED"],
  FAILED: ["SUPERSEDED"],
  REJECTED: ["SUPERSEDED"],
  ACCEPTED: [],
  SUPERSEDED: [],
  CANCELLED: [],
};

export const attemptMachine = defineMachine<AttemptStatus>("attempt", ATTEMPT_TRANSITIONS);
export const assertAttemptTransition = attemptMachine.assertTransition;
