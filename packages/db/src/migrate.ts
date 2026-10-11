import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface MigrationExecutor {
  /** Run one or more SQL statements with no parameters. */
  exec(sqlText: string): Promise<void>;
  /** Run a parameterised query and return rows. */
  query<T = Record<string, unknown>>(sqlText: string, params?: unknown[]): Promise<T[]>;
}

export const DEFAULT_MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/**
 * Plain-SQL migration runner. Files run in name order, each inside a transaction,
 * and are recorded in schema_migrations. Run as the database owner, never as app_user.
 */
export async function runMigrations(ex: MigrationExecutor, dir: string = DEFAULT_MIGRATIONS_DIR): Promise<string[]> {
  await ex.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const applied = new Set((await ex.query<{ name: string }>(`SELECT name FROM schema_migrations`)).map((r) => r.name));
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const body = readFileSync(join(dir, file), "utf8");
    await ex.exec("BEGIN");
    try {
      await ex.exec(body);
      await ex.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [file]);
      await ex.exec("COMMIT");
    } catch (err) {
      await ex.exec("ROLLBACK");
      throw new Error(`migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    ran.push(file);
  }
  return ran;
}
