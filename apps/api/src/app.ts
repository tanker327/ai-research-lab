// Hono app. Ticket 1.6 lands the SSE stream; the rest of the API surface is
// ticket 1.8.
import { cancelRun, startRun } from "@lab/core";
import type { Db } from "@lab/db";
import {
  selectAttemptsByRun,
  selectEventsAfter,
  selectLiveClaimEvidence,
  selectLiveClaims,
  selectModelCallsByAttempt,
  selectRun,
  selectRuns,
  selectTasksByRun,
  selectToolCallsByAttempt,
} from "@lab/db";
import { CreateRunRequest } from "@lab/schemas";
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

  // Phase 1 run creation: explicit task list, Zod-validated (rule 7 applies
  // to anything control-relevant, requests included).
  app.post("/runs", async (c) => {
    const parsed = CreateRunRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
    }
    const req = parsed.data;
    // Planner-driven run (3.7): no explicit tasks → seed the stage-1 plan
    // task; the PlanDelta interpreter grows the DAG from there (ADR-011).
    const requested =
      req.tasks ??
      ([
        {
          type: "plan",
          title: "Plan · stage 1",
          priority: 90,
          strategy: null,
          maxAttempts: 3,
          input: { planStage: 1 },
          dependsOn: [],
        },
      ] as const);
    // Tasks with dependants need stable ids before insert.
    const tasks = requested.map((t) => ({ ...t, strategy: t.strategy ?? null }));
    const id = await startRun(db, { ...req, title: req.title ?? null, tasks });
    log.info({ runId: id, tasks: tasks.length }, "run created");
    return c.json({ id }, 201);
  });

  app.get("/runs", async (c) => {
    return c.json(await selectRuns(db));
  });

  app.get("/runs/:id", async (c) => {
    const run = await selectRun(db, c.req.param("id"));
    return run ? c.json(run) : c.json({ error: "not found" }, 404);
  });

  app.get("/runs/:id/tasks", async (c) => {
    return c.json(await selectTasksByRun(db, c.req.param("id")));
  });

  // Console inspector (ticket 2.5): attempts with their model/tool calls.
  // Evidence & claims browser (3.7): live canonical claims + their live
  // evidence, grouped claim-first. Reads go through live_* views only.
  app.get("/runs/:id/claims", async (c) => {
    const runId = c.req.param("id");
    const [claims, evidence] = await Promise.all([
      selectLiveClaims(db, runId),
      selectLiveClaimEvidence(db, runId),
    ]);
    const byClaim = new Map<string, typeof evidence>();
    for (const e of evidence) {
      byClaim.set(e.canonicalClaimId, [...(byClaim.get(e.canonicalClaimId) ?? []), e]);
    }
    return c.json(
      claims.map((cl) => ({
        ...cl,
        evidence: (byClaim.get(cl.id) ?? []).map((e) => ({
          relation: e.relation,
          excerpt: e.excerpt,
          sourceUrl: e.sourceUrl,
          sourceClass: e.sourceClass,
          vendorAffiliated: e.vendorAffiliated,
          benchmarkOrigin: e.benchmarkOrigin,
          retrievedAt: e.retrievedAt,
        })),
      })),
    );
  });

  app.get("/runs/:id/attempts", async (c) => {
    return c.json(await selectAttemptsByRun(db, c.req.param("id")));
  });

  app.get("/attempts/:id/calls", async (c) => {
    const attemptId = c.req.param("id");
    const [modelCalls, toolCalls] = await Promise.all([
      selectModelCallsByAttempt(db, attemptId),
      selectToolCallsByAttempt(db, attemptId),
    ]);
    return c.json({ modelCalls, toolCalls });
  });

  app.get("/runs/:id/events", async (c) => {
    return c.json(
      await selectEventsAfter(db, c.req.param("id"), c.req.query("after") ?? null, 2000),
    );
  });

  app.post("/runs/:id/cancel", async (c) => {
    try {
      await cancelRun(db, c.req.param("id"), "api");
      return c.json({ cancelled: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.includes("does not exist") ? 404 : 409;
      return c.json({ error: message }, status);
    }
  });

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
