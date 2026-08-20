// Exhaustive transition-matrix tests (phase-1-plan Session A acceptance).
// Every (from, to) cell of every machine is exercised — legal cells pass,
// illegal cells throw InvalidTransitionError. Driven from the Zod enums so a
// status added to @lab/schemas without a matrix row fails here, not in prod.
import { AttemptStatus, RunStatus, TaskStatus } from "@lab/schemas";
import { describe, expect, it } from "vitest";
import { attemptMachine } from "./attempt";
import { InvalidTransitionError, type StateMachine } from "./machine";
import { runMachine } from "./run";
import { assertTransition, TASK_TRANSITIONS, taskMachine } from "./task";

function exhaustive<S extends string>(machine: StateMachine<S>, allStatuses: readonly S[]) {
  describe(`${machine.entity} machine`, () => {
    it("covers every status in the enum", () => {
      expect(Object.keys(machine.transitions).sort()).toEqual([...allStatuses].sort());
    });

    it("every target status exists in the enum", () => {
      for (const targets of Object.values<readonly S[]>(machine.transitions)) {
        for (const to of targets) expect(allStatuses).toContain(to);
      }
    });

    for (const from of allStatuses) {
      for (const to of allStatuses) {
        const legal = machine.transitions[from].includes(to);
        it(`${from} → ${to} is ${legal ? "legal" : "illegal"}`, () => {
          if (legal) {
            expect(() => machine.assertTransition(from, to)).not.toThrow();
            expect(machine.can(from, to)).toBe(true);
          } else {
            expect(() => machine.assertTransition(from, to)).toThrow(InvalidTransitionError);
            expect(machine.can(from, to)).toBe(false);
          }
        });
      }
    }

    it("self-transitions are never legal", () => {
      for (const s of allStatuses) expect(machine.can(s, s)).toBe(false);
    });
  });
}

exhaustive(taskMachine, TaskStatus.options);
exhaustive(attemptMachine, AttemptStatus.options);
exhaustive(runMachine, RunStatus.options);

describe("terminal states", () => {
  it("task terminals are DONE/CANCELLED; FAILED exits only to CANCELLED (6.4 human retirement)", () => {
    const terminals = TaskStatus.options.filter((s) => taskMachine.isTerminal(s));
    expect(terminals.sort()).toEqual(["CANCELLED", "DONE"]);
    expect(TASK_TRANSITIONS.FAILED).toEqual(["CANCELLED"]);
  });

  it("attempt terminals are ACCEPTED/SUPERSEDED/CANCELLED with no exits", () => {
    const terminals = AttemptStatus.options.filter((s) => attemptMachine.isTerminal(s));
    expect(terminals.sort()).toEqual(["ACCEPTED", "CANCELLED", "SUPERSEDED"]);
  });

  it("run terminals are COMPLETED/FAILED/CANCELLED with no exits", () => {
    const terminals = RunStatus.options.filter((s) => runMachine.isTerminal(s));
    expect(terminals.sort()).toEqual(["CANCELLED", "COMPLETED", "FAILED"]);
  });
});

describe("load-bearing paths", () => {
  it("the §5.3 accept transaction replays legally (supersede SUCCEEDED/FAILED/REJECTED)", () => {
    for (const from of ["SUCCEEDED", "FAILED", "REJECTED"] as const) {
      expect(attemptMachine.can(from, "SUPERSEDED")).toBe(true);
    }
    expect(attemptMachine.can("SUCCEEDED", "ACCEPTED")).toBe(true);
  });

  it("stale-claim release: RUNNING task returns to READY", () => {
    expect(taskMachine.can("RUNNING", "READY")).toBe(true);
  });

  it("WAITING_HUMAN loops back to every active run phase", () => {
    for (const phase of [
      "PLANNING",
      "RESEARCHING",
      "ANALYZING",
      "EVALUATING",
      "SYNTHESIZING",
    ] as const) {
      expect(runMachine.can("WAITING_HUMAN", phase)).toBe(true);
    }
  });

  it("gap cycle: EVALUATING loops back to RESEARCHING (bounded by cycle guard, ADR-016)", () => {
    expect(runMachine.can("EVALUATING", "RESEARCHING")).toBe(true);
  });
});

describe("InvalidTransitionError", () => {
  it("is a PERMANENT_INFRA CategorizedError carrying {entity, from, to}", () => {
    try {
      assertTransition("DONE", "READY");
      expect.unreachable("must throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidTransitionError);
      const e = err as InvalidTransitionError;
      expect(e.category).toBe("PERMANENT_INFRA");
      expect(e.detail).toEqual({ entity: "task", from: "DONE", to: "READY" });
      expect(e.message).toContain("DONE");
      expect(e.message).toContain("READY");
    }
  });
});
