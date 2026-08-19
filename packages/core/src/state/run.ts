// Run state machine (design §8.2). The staged loop advances
// PLANNING → RESEARCHING → ANALYZING → EVALUATING → SYNTHESIZING → COMPLETED;
// EVALUATING may loop back to RESEARCHING (gap-driven cycle, bounded by the
// deterministic cycle guard — ADR-016). WAITING_HUMAN is enterable from any
// active phase and loops back to it when the checkpoint resolves.
import type { RunStatus } from "@lab/schemas";
import { defineMachine } from "./machine";

const ACTIVE_PHASES: readonly RunStatus[] = [
  "PLANNING",
  "RESEARCHING",
  "ANALYZING",
  "EVALUATING",
  "SYNTHESIZING",
];

export const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  CREATED: ["PLANNING", "CANCELLED"],
  PLANNING: ["RESEARCHING", "WAITING_HUMAN", "FAILED", "CANCELLED"],
  RESEARCHING: ["ANALYZING", "WAITING_HUMAN", "FAILED", "CANCELLED"],
  ANALYZING: ["EVALUATING", "WAITING_HUMAN", "FAILED", "CANCELLED"],
  EVALUATING: ["SYNTHESIZING", "RESEARCHING", "WAITING_HUMAN", "FAILED", "CANCELLED"],
  SYNTHESIZING: ["COMPLETED", "WAITING_HUMAN", "FAILED", "CANCELLED"],
  WAITING_HUMAN: [...ACTIVE_PHASES, "FAILED", "CANCELLED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export const runMachine = defineMachine<RunStatus>("run", RUN_TRANSITIONS);
export const assertRunTransition = runMachine.assertTransition;
