import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import type { Db } from "./client.js";
import { runMigrations, type MigrationExecutor } from "./migrate.js";
import * as schema from "./schema.js";

/** An in-process Postgres (PGlite) with the schema applied. Real RLS, real triggers, no Docker. */
export async function createTestDatabase(): Promise<{ pg: PGlite; db: Db; close: () => Promise<void> }> {
  const pg = new PGlite({ extensions: { pg_trgm } });
  await pg.waitReady;
  await runMigrations(pgliteExecutor(pg));
  const db = drizzle(pg, { schema }) as unknown as Db;
  return { pg, db, close: () => pg.close() };
}

export function pgliteExecutor(pg: PGlite): MigrationExecutor {
  return {
    exec: async (text) => {
      await pg.exec(text);
    },
    query: async (text, params = []) => (await pg.query(text, params as never[])).rows as never[],
  };
}
