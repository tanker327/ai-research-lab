// Hono app. Ticket 1.6 lands the SSE stream; the rest of the API surface is
// ticket 1.8.
import type { Db } from "@lab/db";
import { selectEventsAfter } from "@lab/db";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Logger } from "pino";
import type { EventBus } from "./event-bus";

export interface ApiDeps {
  db: Db;
  bus: EventBus;
  log: Logger;
}

export function createApp({ db, bus, log }: ApiDeps): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));

  // Live event stream for a run. Reconnect-safe: the browser (or any client)
  // sends Last-Event-ID and delivery resumes after that UUIDv7 cursor; ?after=
  // is the manual equivalent. Rows are drained fully after every wake, so a
  // single doorbell delivers any number of events in id order.
  app.get("/runs/:id/events/stream", (c) => {
    const runId = c.req.param("id");
    let cursor = c.req.header("Last-Event-ID") ?? c.req.query("after") ?? null;

    return streamSSE(c, async (stream) => {
      let open = true;
      let wake: (() => void) | null = null;
      const kick = () => wake?.();
      const unsubscribe = bus.subscribe(runId, kick);
      stream.onAbort(() => {
        open = false;
        kick();
      });

      try {
        while (open) {
          const rows = await selectEventsAfter(db, runId, cursor);
          for (const e of rows) {
            await stream.writeSSE({ id: e.id, event: e.type, data: JSON.stringify(e) });
            cursor = e.id;
          }
          if (rows.length > 0) continue; // drain before sleeping
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = null;
        }
      } catch (err) {
        log.warn({ err, runId }, "event stream closed on error");
      } finally {
        unsubscribe();
      }
    });
  });

  return app;
}
