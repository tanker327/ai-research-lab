// emitEvent — every state change emits an event in the same transaction as
// the change (CLAUDE.md rule 8). Callers pass the open transaction; this never
// opens its own.
import { insertEventAndNotify, type SqlExecutor } from "@lab/db";
import { type EventKind, newId } from "@lab/schemas";

export interface EmitEvent {
  runId: string;
  taskId?: string | null;
  attemptId?: string | null;
  type: string;
  kind: EventKind;
  actor: string;
  payload?: Record<string, unknown>;
}

export async function emitEvent(tx: SqlExecutor, e: EmitEvent): Promise<string> {
  const id = newId(); // UUIDv7 — the SSE cursor is chronological id order (D2)
  await insertEventAndNotify(tx, { id, ...e });
  return id;
}
