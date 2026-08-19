import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Db = ReturnType<typeof createDb>["db"];
// The transaction handle drizzle passes to db.transaction callbacks. Raw query
// functions accept Db | Tx so orchestrators (packages/core) own the boundaries.
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type SqlExecutor = Db | Tx;

export function createDb(databaseUrl: string) {
  const sql = postgres(databaseUrl);
  const db = drizzle(sql, { schema });
  return { db, sql, close: () => sql.end() };
}
