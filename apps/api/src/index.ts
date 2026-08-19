// Api process: HTTP surface + scheduler + event fanout (V0.05 layout — the
// scheduler lives here, one per deployment). API_BOOT_ONLY=1 boots, connects,
// and exits (gate scripts).
import { createLogger, loadConfig, startScheduler } from "@lab/core";
import { createDb } from "@lab/db";
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
  const scheduler = startScheduler(db, config, log);
  const app = createApp({ db, bus, log });
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
