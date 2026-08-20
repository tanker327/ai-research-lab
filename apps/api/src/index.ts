// Api process: HTTP surface + scheduler + event fanout (V0.05 layout — the
// scheduler lives here, one per deployment). API_BOOT_ONLY=1 boots, connects,
// and exits (gate scripts).
import { createLogger, emitEvent, loadConfig, startScheduler } from "@lab/core";
import { createArtifactStore, createDb } from "@lab/db";
import { canonicalizeRun, createModelMergeConfirmer } from "@lab/evidence";
import { createModelClient } from "@lab/model";
import { createApp } from "./app";
import { createEventBus } from "./event-bus";

export async function boot() {
  const config = loadConfig();
  const log = createLogger("api");
  const { db, sql, close } = createDb(config.DATABASE_URL);
  await sql`SELECT 1`;
  log.info({ database: "connected" }, "api boot ok");
  return { config, log, db, close };
}

export async function serve() {
  const { config, log, db, close } = await boot();
  const bus = createEventBus(config.DATABASE_URL, log);

  // Canonicalization (ticket 3.5): composed HERE because core must not import
  // @lab/evidence (it pulls in @lab/model). Merge confirmation runs on the
  // fast tier; model failure degrades to no-merge inside canonicalizeRun.
  const mergeModel = createModelClient({
    baseUrl: config.AIHUB_BASE_URL,
    serviceName: config.AIHUB_SERVICE_NAME,
    db,
  });
  const scheduler = startScheduler(db, config, log, {
    onAccepted: async (accepts) => {
      for (const { runId, attemptId } of accepts) {
        const result = await canonicalizeRun(
          db,
          runId,
          createModelMergeConfirmer(mergeModel, config.MODEL_FAST_LOCAL, runId, attemptId),
        );
        await emitEvent(db, {
          runId,
          type: "CANONICALIZATION_COMPLETED",
          kind: "info",
          actor: "canonicalizer",
          payload: {
            claims: result.canonicalIds.length,
            merged: result.merged,
            contested: result.contested,
            linked: result.linked,
          },
        });
      }
    },
  });
  const app = createApp({ db, bus, log, artifacts: createArtifactStore(config.ARTIFACT_ROOT) });
  const server = Bun.serve({ fetch: app.fetch, port: config.API_PORT });
  log.info({ port: config.API_PORT }, "api listening");

  const shutdown = async () => {
    scheduler.stop();
    await server.stop();
    await bus.stop();
    await close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return server;
}

if (import.meta.main) {
  if (process.env.API_BOOT_ONLY === "1") {
    const { close } = await boot();
    await close();
  } else {
    await serve();
  }
}
