// Cross-process event fanout, api side (decision D2). One DEDICATED postgres.js
// connection LISTENs on lab_events (never a pool connection — notifications
// would stall behind queries); a fallback poll tick wakes every subscriber so
// a NOTIFY missed during reconnect only delays delivery, never loses it. The
// events table stays the source of truth — the bus carries no event data,
// only "check for new rows".
import { EVENT_CHANNEL } from "@lab/db";
import type { Logger } from "pino";
import postgres from "postgres";

export interface EventBus {
  subscribe(runId: string, wake: () => void): () => void;
  stop(): Promise<void>;
}

export function createEventBus(
  databaseUrl: string,
  log: Logger,
  { pollMs = 2_000 }: { pollMs?: number } = {},
): EventBus {
  const subscribers = new Map<string, Set<() => void>>();

  const wakeRun = (runId: string) => {
    for (const wake of subscribers.get(runId) ?? []) wake();
  };
  const wakeAll = () => {
    for (const set of subscribers.values()) for (const wake of set) wake();
  };

  // max 1: this client exists only to hold the LISTEN connection.
  const listenSql = postgres(databaseUrl, { max: 1 });
  const listening = listenSql
    .listen(
      EVENT_CHANNEL,
      (runId) => wakeRun(runId),
      () => log.info({ channel: EVENT_CHANNEL }, "LISTEN connection (re)established"),
    )
    .catch((err) => {
      log.error({ err }, "LISTEN failed — relying on the fallback poll");
      return null;
    });

  const poll = setInterval(wakeAll, pollMs);

  return {
    subscribe(runId, wake) {
      let set = subscribers.get(runId);
      if (!set) {
        set = new Set();
        subscribers.set(runId, set);
      }
      set.add(wake);
      return () => {
        set.delete(wake);
        if (set.size === 0) subscribers.delete(runId);
      };
    },
    async stop() {
      clearInterval(poll);
      await (await listening)?.unlisten().catch(() => {});
      await listenSql.end();
    },
  };
}
