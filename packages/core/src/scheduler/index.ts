// Interval runner for the sweeps — lives in the api process (V0.05, one
// scheduler per deployment). Sweep errors are logged and the interval keeps
// going: a transient DB blip must not kill the scheduler.
import type { Db } from "@lab/db";
import type { Logger } from "pino";
import type { Config } from "../config";
import { sweepEvaluations } from "./evaluate";
import { sweepRunCompletion } from "./run";
import { sweepReadiness, sweepStaleClaims } from "./sweeps";

export * from "./budget";
export * from "./evaluate";
export * from "./guards";
export * from "./run";
export * from "./sweeps";

export interface SchedulerHooks {
  // Called after a control tick that accepted attempts, once per affected
  // run. Composed by the api process — e.g. canonicalization (@lab/evidence),
  // which core must not import (rule 1: it pulls in @lab/model).
  onAccepted?: (accepts: Array<{ runId: string; attemptId: string }>) => Promise<void>;
}

export function startScheduler(
  db: Db,
  config: Config,
  log: Logger,
  hooks: SchedulerHooks = {},
): { stop: () => void } {
  const guard = (name: string, fn: () => Promise<unknown>) => async () => {
    try {
      await fn();
    } catch (err) {
      log.error({ err, sweep: name }, "sweep failed; will retry on next tick");
    }
  };

  // One control tick: evaluation verdicts, readiness promotion, run phase
  // walk. Ordered so a task accepted this tick can unblock dependents and
  // complete its run in the same tick.
  const readiness = setInterval(
    guard("control", async () => {
      const evaluated = await sweepEvaluations(
        db,
        undefined,
        config.DEFAULT_MAX_ATTEMPTS,
        config.MIN_EVIDENCE_PER_TASK,
      );
      // Canonicalization BEFORE the completion sweep: the staged-planning
      // driver decides on live claims, which only exist after this hook runs
      // (found live: stage 2 never fired because claims landed one tick late).
      if (evaluated.acceptedRuns.length > 0 && hooks.onAccepted) {
        await hooks.onAccepted(evaluated.acceptedRuns);
      }
      const { ready, blocked } = await sweepReadiness(db);
      const runs = await sweepRunCompletion(db, config.MAX_PLAN_STAGES);
      if (
        ready.length ||
        blocked.length ||
        evaluated.accepted.length ||
        evaluated.retried.length ||
        evaluated.failed.length ||
        runs.completed.length ||
        runs.failed.length
      ) {
        log.info({ evaluated, ready, blocked, runs }, "control sweep");
      }
    }),
    config.POLL_INTERVAL_MS,
  );

  const stale = setInterval(
    guard("stale-claims", async () => {
      const released = await sweepStaleClaims(db, config.TASK_CLAIM_TIMEOUT_S);
      if (released.length) log.warn({ released }, "stale claims released");
    }),
    config.STALE_SWEEP_INTERVAL_MS,
  );

  return {
    stop: () => {
      clearInterval(readiness);
      clearInterval(stale);
    },
  };
}
