// Event insert + NOTIFY doorbell (decision D2): the row is the source of
// truth; the notify payload is just the run_id so api-side listeners know to
// re-read rows by id > last_seen. Same transaction as the state change
// (CLAUDE.md rule 8) — a rolled-back change never rings the bell.
import type { EventKind } from "@lab/schemas";
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../client";

export const EVENT_CHANNEL = "lab_events";

export interface NewEvent {
  id: string;
  runId: string;
  taskId?: string | null;
  attemptId?: string | null;
  type: string;
  kind: EventKind;
  actor: string;
  payload?: Record<string, unknown>;
}

export async function insertEventAndNotify(tx: SqlExecutor, e: NewEvent): Promise<void> {
  await tx.execute(sql`
    INSERT INTO events (id, run_id, task_id, attempt_id, type, kind, actor, payload)
    VALUES (${e.id}, ${e.runId}, ${e.taskId ?? null}, ${e.attemptId ?? null},
            ${e.type}, ${e.kind}, ${e.actor}, ${JSON.stringify(e.payload ?? {})}::jsonb)`);
  await tx.execute(sql`SELECT pg_notify(${EVENT_CHANNEL}, ${e.runId})`);
}
