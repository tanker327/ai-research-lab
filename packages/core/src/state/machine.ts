// Generic state-machine plumbing shared by the task/attempt/run machines (§5.1).
// Pure functions only — every repository status update calls assertTransition
// inside the same DB transaction (CLAUDE.md rule 3).
import { CategorizedError } from "@lab/schemas";

// An illegal transition is a bug surfaced loudly, never a retryable state —
// hence PERMANENT_INFRA, so decideRetry never turns it into a backoff loop.
export class InvalidTransitionError extends CategorizedError {
  readonly from: string;
  readonly to: string;

  constructor(entity: string, { from, to }: { from: string; to: string }) {
    super("PERMANENT_INFRA", `Illegal ${entity} transition: ${from} → ${to}`, {
      detail: { entity, from, to },
    });
    this.name = "InvalidTransitionError";
    this.from = from;
    this.to = to;
  }
}

export interface StateMachine<S extends string> {
  readonly entity: string;
  readonly transitions: Readonly<Record<S, readonly S[]>>;
  can(from: S, to: S): boolean;
  assertTransition(from: S, to: S): void;
  isTerminal(state: S): boolean;
}

export function defineMachine<S extends string>(
  entity: string,
  transitions: Readonly<Record<S, readonly S[]>>,
): StateMachine<S> {
  return {
    entity,
    transitions,
    can: (from, to) => transitions[from].includes(to),
    assertTransition(from, to) {
      if (!transitions[from].includes(to)) throw new InvalidTransitionError(entity, { from, to });
    },
    isTerminal: (state) => transitions[state].length === 0,
  };
}
