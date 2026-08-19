// Worker: poll → claim → dispatch → finish (§8.3, ticket 1.2). One process =
// one claimer; run several for concurrency. WORKER_RUN_ONCE=1 does a single
// poll iteration and exits (used by gate scripts and boot checks).
import {
  type ClaimedWork,
  claimNextReadyTask,
  createLogger,
  finishAttempt,
  loadConfig,
} from "@lab/core";
import { createDb, type Db } from "@lab/db";
import { CategorizedError } from "@lab/schemas";
import { createHandlerRegistry, type TaskHandler } from "./handlers";

export async function runWorker({ once = false } = {}): Promise<void> {
  const config = loadConfig();
  const workerId = process.env.WORKER_ID ?? `worker-${process.pid}`;
  const log = createLogger("worker").child({ workerId });
  const { db, sql, close } = createDb(config.DATABASE_URL);
  await sql`SELECT 1`;
  log.info({ database: "connected", once }, "worker boot ok");

  const registry = createHandlerRegistry();
  let running = true;
  const stop = (signal: string) => {
    log.info({ signal }, "shutting down after current poll");
    running = false;
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  while (running) {
    // A claim failure (e.g. Postgres restarting — matrix row 7) is a pause,
    // not a crash: idempotency lives in the DB, the worker just reconnects.
    let work: ClaimedWork | null = null;
    try {
      work = await claimNextReadyTask(db, workerId);
    } catch (err) {
      log.error({ err }, "claim failed; backing off");
      await Bun.sleep(config.POLL_INTERVAL_MS * 4);
      continue;
    }
    if (!work) {
      if (once) break;
      await Bun.sleep(config.POLL_INTERVAL_MS);
      continue;
    }
    await executeClaimed(db, registry[work.task.type], work, log);
    if (once) break;
  }
  await close();
}

async function executeClaimed(
  db: Db,
  handler: TaskHandler,
  work: ClaimedWork,
  log: ReturnType<typeof createLogger>,
): Promise<void> {
  const scoped = log.child({
    runId: work.task.runId,
    taskId: work.task.id,
    attemptId: work.attempt.id,
  });
  scoped.info({ type: work.task.type, attemptNumber: work.attempt.attemptNumber }, "claimed");
  try {
    await handler(db, work);
    await finishAttempt(db, work, { ok: true });
    scoped.info("attempt succeeded");
  } catch (err) {
    const error = CategorizedError.from(err);
    try {
      await finishAttempt(db, work, { ok: false, error });
    } catch (finishErr) {
      // DB unreachable: the stale-claim sweep will fail this attempt for us.
      scoped.error({ err: finishErr }, "could not record failure; leaving to stale sweep");
      return;
    }
    scoped.warn({ category: error.category, err: error.message }, "attempt failed");
  }
}

if (import.meta.main) {
  await runWorker({ once: process.env.WORKER_RUN_ONCE === "1" });
}
