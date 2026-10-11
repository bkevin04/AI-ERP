import { drizzle } from "drizzle-orm/postgres-js";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import postgres from "postgres";
import * as schema from "./schema.js";
import type { MigrationExecutor } from "./migrate.js";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export function createPostgresDb(connectionString: string): { db: Db; sql: postgres.Sql; close: () => Promise<void> } {
  const client = postgres(connectionString, { max: 10, prepare: false });
  const db = drizzle(client, { schema }) as unknown as Db;
  return { db, sql: client, close: () => client.end() };
}

export function postgresExecutor(client: postgres.Sql): MigrationExecutor {
  return {
    exec: async (text) => {
      await client.unsafe(text);
    },
    query: async (text, params = []) => (await client.unsafe(text, params as never[])) as unknown as never[],
  };
}
