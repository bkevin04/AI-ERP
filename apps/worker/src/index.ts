import { PgBoss } from "pg-boss";
import { PgCoreStore, createPostgresDb } from "@ai-erp/db";
import { createAnthropicClient, createAnthropicLlmPort } from "@ai-erp/llm";
import { FsObjectStore, JOBS } from "@ai-erp/platform";
import { handleIntakeJob } from "./intake-job.js";
import { handleSyncJob } from "./sync-job.js";

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const { db } = createPostgresDb(databaseUrl);
const root = new PgCoreStore(db, null);
const objects = new FsObjectStore(process.env["OBJECT_STORE_DIR"] ?? ".data/objects");
const llm = createAnthropicLlmPort(createAnthropicClient());
const globalPause = () => process.env["AGENTS_GLOBAL_PAUSE"] === "true";

const boss = new PgBoss({ connectionString: process.env["DATABASE_ADMIN_URL"] ?? databaseUrl });
boss.on("error", (err) => console.error("[pg-boss]", err));
await boss.start();
await boss.createQueue(JOBS.intakeRun);
await boss.createQueue(JOBS.syncMasterData);

await boss.work(JOBS.intakeRun, { batchSize: 1 }, async (jobs) => {
  for (const job of jobs) {
    console.log(`[intake] run ${JSON.stringify(job.data)}`);
    await handleIntakeJob({ db, root, objects, llm, globalPause }, job.data);
  }
});
await boss.work(JOBS.syncMasterData, { batchSize: 1 }, async (jobs) => {
  for (const job of jobs) await handleSyncJob({ db, root }, job.data);
});

console.log("worker started");
