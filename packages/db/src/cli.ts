import { createPostgresDb, postgresExecutor } from "./client.js";
import { runMigrations } from "./migrate.js";

const [cmd] = process.argv.slice(2);
if (cmd !== "migrate") {
  console.error("usage: tsx src/cli.ts migrate");
  process.exit(2);
}
const url = process.env["DATABASE_ADMIN_URL"] ?? process.env["DATABASE_URL"];
if (!url) {
  console.error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
  process.exit(2);
}
const { sql, close } = createPostgresDb(url);
const ran = await runMigrations(postgresExecutor(sql));
console.log(ran.length ? `applied: ${ran.join(", ")}` : "up to date");
await close();
