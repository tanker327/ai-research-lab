// Interval runner for the sweeps — lives in the api process (V0.05, one
// scheduler per deployment). Sweep errors are logged and the interval keeps
// going: a transient DB blip must not kill the scheduler.
import type { Db } from "@lab/db";
import type { Logger } from "pino";
import type { Config } from "../config";
import { sweepReadiness, sweepStaleClaims } from "./sweeps";

export * from "./sweeps";

const STALE_SWEEP_INTERVAL_MS = 30_000;

export function startScheduler(db: Db, config: Config, log: Logger): { stop: () => void } {
  const guard = (name: string, fn: () => Promise<unknown>) => async () => {
    try {
      await fn();
    } catch (err) {
      log.error({ err, sweep: name }, "sweep failed; will retry on next tick");
    }
  };

  const readiness = setInterval(
    guard("readiness", async () => {
      const { ready, blocked } = await sweepReadiness(db);
      if (ready.length || blocked.length) log.info({ ready, blocked }, "readiness sweep");
    }),
    config.POLL_INTERVAL_MS,
  );

  const stale = setInterval(
    guard("stale-claims", async () => {
      const released = await sweepStaleClaims(db, config.TASK_CLAIM_TIMEOUT_S);
      if (released.length) log.warn({ released }, "stale claims released");
    }),
    STALE_SWEEP_INTERVAL_MS,
  );

  return {
    stop: () => {
      clearInterval(readiness);
      clearInterval(stale);
    },
  };
}
