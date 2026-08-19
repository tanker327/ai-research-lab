// Hono app + scheduler arrive with Phase 1 (tickets 1.x). For the Phase 0 gate
// this entrypoint must boot and connect: config parses, DB reachable.
import { createLogger, loadConfig } from "@lab/core";
import { createDb } from "@lab/db";

export async function boot() {
  const config = loadConfig();
  const log = createLogger("api");
  const { sql, close } = createDb(config.DATABASE_URL);
  await sql`SELECT 1`;
  log.info({ database: "connected" }, "api boot ok");
  return { config, close };
}

if (import.meta.main) {
  const { close } = await boot();
  await close(); // Phase 1 replaces this with Bun.serve(app)
}
