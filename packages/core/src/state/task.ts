// Task state machine — implementation-plan §5.1 verbatim. Statuses come from
// @lab/schemas (rule 2); the transition table is the control-plane law here.
import type { TaskStatus } from "@lab/schemas";
import { defineMachine } from "./machine";

export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  CREATED: ["READY", "BLOCKED", "CANCELLED"],
  READY: ["RUNNING", "CANCELLED"],
  RUNNING: ["EVALUATING", "READY", "CANCELLED"], // READY = stale-claim release
  EVALUATING: ["DONE", "READY", "BLOCKED", "WAITING_HUMAN", "FAILED", "CANCELLED"],
  WAITING_HUMAN: ["READY", "CANCELLED"],
  BLOCKED: ["READY", "CANCELLED"], // unblocked by replan
  DONE: [],
  FAILED: [],
  CANCELLED: [],
};

export const taskMachine = defineMachine<TaskStatus>("task", TASK_TRANSITIONS);

// §5.1's exported name; assertTaskTransition is the disambiguated alias used
// once the attempt/run machines are in play.
export const assertTransition = taskMachine.assertTransition;
export const assertTaskTransition = taskMachine.assertTransition;
