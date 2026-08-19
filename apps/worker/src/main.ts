// Worker: poll → claim → dispatch → finish (§8.3, ticket 1.2). One process =
// one claimer; run several for concurrency. WORKER_RUN_ONCE=1 does a single
// poll iteration and exits (used by gate scripts and boot checks).
import { createContextBuilder } from "@lab/context";
import {
  type ClaimedWork,
  claimNextReadyTask,
  createLogger,
  finishAttempt,
  loadConfig,
} from "@lab/core";
import { createArtifactStore, createDb, type Db } from "@lab/db";
import { createArtifactReasoningSink, createModelClient } from "@lab/model";
import { CategorizedError } from "@lab/schemas";
import { createToolRegistry, webFetchTool } from "@lab/tools";
import { createHandlerRegistry, type TaskHandler } from "./handlers";

export async function runWorker({ once = false } = {}): Promise<void> {
  const config = loadConfig();
  const workerId = process.env.WORKER_ID ?? `worker-${process.pid}`;
  const log = createLogger("worker").child({ workerId });
  const { db, sql, close } = createDb(config.DATABASE_URL);
  await sql`SELECT 1`;
  log.info({ database: "connected", once }, "worker boot ok");

  // Real agent dispatch deps (ticket 3.2). Constructing the model client is
  // side-effect free — nothing talks to the hub until an agent task runs.
  const artifacts = createArtifactStore(config.ARTIFACT_ROOT);
  const registry = createHandlerRegistry({
    config,
    model: createModelClient({
      baseUrl: config.AIHUB_BASE_URL,
      serviceName: config.AIHUB_SERVICE_NAME,
      db,
      reasoningSink: createArtifactReasoningSink(artifacts, db),
      concurrency: { strong_local: config.GPU_CONCURRENCY_STRONG_LOCAL },
    }),
    tools: createToolRegistry({ db, store: artifacts, fetchImpl: fetch }, [webFetchTool]),
    artifacts,
    context: createContextBuilder({
      db,
      capabilities: [{ name: "web_fetch", description: "fetch a URL; page snapshot is persisted" }],
    }),
  });
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
