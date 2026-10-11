import { Hono } from "hono";
import { z } from "zod";
import { DocumentKind } from "@ai-erp/contracts";
import { ToolError, invokeTool, newId, sha256, type InvokeEnv, type PrincipalContext } from "@ai-erp/core";
import { JOBS, kindFromMime } from "@ai-erp/platform";
import type { ApiDeps } from "./deps.js";

type Vars = { env: InvokeEnv };

export function createApp(deps: ApiDeps) {
  const app = new Hono<{ Variables: Vars }>();

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.onError((err, c) => {
    if (err instanceof ToolError) return c.json({ error: err.code, message: err.message, details: err.details ?? null }, err.httpStatus as 400);
    console.error(err);
    return c.json({ error: "internal", message: "internal error" }, 500);
  });

  // ---- authentication: API key -> principal -> tenant ------------------------------
  app.use("/v1/*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const key = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
    if (!key) return c.json({ error: "unauthorized", message: "missing bearer token" }, 401);
    const env = await envForPrincipal(deps, await deps.store.resolvePrincipalByApiKeyHash(sha256(key)));
    if (!env) return c.json({ error: "unauthorized", message: "invalid api key" }, 401);
    c.set("env", env);
    await next();
  });

  // ---- tools --------------------------------------------------------------------------
  app.get("/v1/tools", (c) => c.json({ tools: deps.registry.describeAll("http") }));

  const ToolCall = z.object({ input: z.unknown().default({}), idempotencyKey: z.string().optional(), sourceDocumentIds: z.array(z.uuid()).optional() });
  app.post("/v1/tools/:name", async (c) => {
    const name = c.req.param("name");
    const tool = deps.registry.get(name);
    if (!tool || !tool.exposure.includes("http")) throw new ToolError("not_found", `unknown tool: ${name}`);
    const body = ToolCall.parse(await c.req.json().catch(() => ({})));
    const r = await invokeTool(c.get("env"), name, body.input, { idempotencyKey: body.idempotencyKey, sourceDocumentIds: body.sourceDocumentIds });
    return c.json({ output: r.output, replayed: r.replayed });
  });

  // ---- documents ---------------------------------------------------------------------
  const Upload = z.object({
    filename: z.string().nullable().default(null),
    mime: z.string(),
    kind: DocumentKind.optional(),
    contentBase64: z.string(),
    fromAddress: z.string().nullable().default(null),
    providerMessageId: z.string().nullable().default(null),
    /** Start an intake run for this document right away. */
    startRun: z.boolean().default(true),
  });
  app.post("/v1/documents", async (c) => {
    const body = Upload.parse(await c.req.json());
    const env = c.get("env");
    const bytes = Buffer.from(body.contentBase64, "base64");
    const doc = await storeAndIngest(deps, env, { bytes, mime: body.mime, kind: body.kind ?? kindFromMime(body.mime, body.filename), filename: body.filename, fromAddress: body.fromAddress, providerMessageId: body.providerMessageId, parentDocumentId: null });
    let jobId: string | null = null;
    if (body.startRun && doc.eventCreated) jobId = await enqueueIntake(deps, env, doc.eventId, [doc.documentId], body.fromAddress);
    return c.json({ ...doc, jobId }, doc.created ? 201 : 200);
  });

  app.get("/v1/proposals", async (c) => {
    const env = c.get("env");
    const statuses = (c.req.query("status") ?? "pending_approval,checks_failed,auto_approved").split(",");
    const store = deps.store.forTenant(env.tenant.id);
    return c.json({ proposals: await store.listProposals(statuses, Number(c.req.query("limit") ?? 50)) });
  });

  // ---- Postmark inbound webhook: orders+<slug>@in.<domain> ---------------------------------
  const PostmarkInbound = z.object({
    MessageID: z.string(),
    From: z.string(),
    OriginalRecipient: z.string().optional(),
    ToFull: z.array(z.object({ Email: z.string(), MailboxHash: z.string().optional() })).optional(),
    Subject: z.string().optional(),
    TextBody: z.string().optional(),
    HtmlBody: z.string().optional(),
    Attachments: z.array(z.object({ Name: z.string(), Content: z.string(), ContentType: z.string() })).default([]),
  });
  app.post("/webhooks/postmark", async (c) => {
    const token = c.req.query("token") ?? c.req.header("x-inbound-token");
    if (!deps.postmarkToken || token !== deps.postmarkToken) return c.json({ error: "unauthorized" }, 401);
    const body = PostmarkInbound.parse(await c.req.json());
    const slug = mailboxSlug(body);
    const mailbox = slug ? await deps.store.resolveInboundMailbox(slug) : null;
    if (!mailbox) return c.json({ error: "unknown_mailbox", slug }, 404);
    const store = deps.store.forTenant(mailbox.tenantId);
    const tenant = await store.getTenant(mailbox.tenantId);
    const principal = await store.getPrincipal(mailbox.principalId);
    if (!tenant || !principal) return c.json({ error: "unknown_mailbox", slug }, 404);
    const env: InvokeEnv = { registry: deps.registry, store, tenant, principal, globalPause: deps.globalPause };

    const from = extractEmail(body.From);
    const text = `Subject: ${body.Subject ?? ""}\nFrom: ${body.From}\n\n${body.TextBody ?? htmlToText(body.HtmlBody ?? "")}`;
    const email = await storeAndIngest(deps, env, { bytes: Buffer.from(text, "utf8"), mime: "text/plain", kind: "email", filename: null, fromAddress: from, providerMessageId: body.MessageID, parentDocumentId: null });
    const documentIds = [email.documentId];
    for (const a of body.Attachments) {
      const bytes = Buffer.from(a.Content, "base64");
      const att = await storeAndIngest(deps, env, { bytes, mime: a.ContentType, kind: kindFromMime(a.ContentType, a.Name), filename: a.Name, fromAddress: from, providerMessageId: body.MessageID, parentDocumentId: email.documentId });
      documentIds.push(att.documentId);
    }
    const jobId = email.eventCreated ? await enqueueIntake(deps, env, email.eventId, documentIds, from) : null;
    return c.json({ ok: true, tenantId: mailbox.tenantId, documentIds, jobId, duplicate: !email.eventCreated });
  });

  return app;
}

export async function envForPrincipal(deps: ApiDeps, principal: PrincipalContext | null): Promise<InvokeEnv | null> {
  if (!principal) return null;
  const store = deps.store.forTenant(principal.tenantId);
  const tenant = await store.getTenant(principal.tenantId);
  if (!tenant) return null;
  return { registry: deps.registry, store, tenant, principal, globalPause: deps.globalPause };
}

async function storeAndIngest(
  deps: ApiDeps,
  env: InvokeEnv,
  d: { bytes: Buffer; mime: string; kind: z.infer<typeof DocumentKind>; filename: string | null; fromAddress: string | null; providerMessageId: string | null; parentDocumentId: string | null },
) {
  const hash = sha256(d.bytes);
  const storageKey = `${env.tenant.id}/${hash}`;
  await deps.objects.put(storageKey, d.bytes, d.mime);
  const r = await invokeTool<{ documentId: string; created: boolean; eventId: string; eventCreated: boolean }>(env, "ingest_document", {
    kind: d.kind, storageKey, sha256: hash, mime: d.mime, filename: d.filename, parentDocumentId: d.parentDocumentId,
    fromAddress: d.fromAddress, providerMessageId: d.providerMessageId, textKey: null, pageCount: null,
  });
  return r.output;
}

async function enqueueIntake(deps: ApiDeps, env: InvokeEnv, eventId: string, documentIds: string[], senderEmail: string | null): Promise<string | null> {
  return deps.queue.enqueue(JOBS.intakeRun, { tenantId: env.tenant.id, eventId, documentIds, senderEmail, runId: newId() }, { singletonKey: `intake:${eventId}` });
}

function mailboxSlug(body: { OriginalRecipient?: string; ToFull?: Array<{ Email: string; MailboxHash?: string }> }): string | null {
  const hash = body.ToFull?.find((t) => t.MailboxHash)?.MailboxHash;
  if (hash) return hash.toLowerCase();
  const addr = body.OriginalRecipient ?? body.ToFull?.[0]?.Email ?? "";
  const m = /\+([a-z0-9-]+)@/i.exec(addr);
  return m ? m[1]!.toLowerCase() : null;
}

function extractEmail(from: string): string | null {
  const m = /<([^>]+)>/.exec(from);
  const raw = (m?.[1] ?? from).trim().toLowerCase();
  return raw.includes("@") ? raw : null;
}

function htmlToText(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
}
