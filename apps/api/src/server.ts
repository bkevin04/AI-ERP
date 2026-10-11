import { serve } from "@hono/node-server";
import type { HttpBindings } from "@hono/node-server";
import type { Hono } from "hono";
import { PgBoss } from "pg-boss";
import { createDefaultRegistry } from "@ai-erp/core";
import { PgCoreStore, createPostgresDb } from "@ai-erp/db";
import { FsObjectStore, type JobQueue } from "@ai-erp/platform";
import { createApp } from "./app.js";
import { mountMcp } from "./mcp-route.js";

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const { db } = createPostgresDb(databaseUrl);
const boss = new PgBoss({ connectionString: process.env["DATABASE_ADMIN_URL"] ?? databaseUrl });
await boss.start();
const queue: JobQueue = {
  enqueue: (name, data, opts) => boss.send(name, data, opts?.singletonKey ? { singletonKey: opts.singletonKey } : {}),
};

const root = new PgCoreStore(db, null);
const app = createApp({
  registry: createDefaultRegistry(),
  store: root,
  objects: new FsObjectStore(process.env["OBJECT_STORE_DIR"] ?? ".data/objects"),
  queue,
  globalPause: process.env["AGENTS_GLOBAL_PAUSE"] === "true",
  postmarkToken: process.env["POSTMARK_INBOUND_TOKEN"] ?? null,
});
mountMcp(app as unknown as Hono<{ Bindings: HttpBindings }>, {
  registry: createDefaultRegistry(), store: root, objects: new FsObjectStore(".data/objects"), queue, globalPause: process.env["AGENTS_GLOBAL_PAUSE"] === "true", postmarkToken: null,
});

const port = Number(process.env["PORT"] ?? 3000);
serve({ fetch: app.fetch, port }, () => console.log(`api listening on :${port}`));
