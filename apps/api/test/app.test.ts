import { describe, expect, it } from "vitest";
import { createDefaultRegistry, sha256 } from "@ai-erp/core";
import { MemoryDb } from "@ai-erp/core/testing";
import { MemoryJobQueue, MemoryObjectStore } from "@ai-erp/platform";
import { createApp } from "../src/app.js";
import type { ApiStoreRoot } from "../src/deps.js";

function setup() {
  const db = new MemoryDb();
  const tenant = db.addTenant({ slug: "acme" });
  db.addPrincipal({ tenantId: tenant.id, kind: "human", scopes: ["admin"], apiKeyHash: sha256("admin-key") });
  db.addPrincipal({ tenantId: tenant.id, kind: "agent", scopes: ["customers:read"], apiKeyHash: sha256("agent-key") });
  db.addPrincipal({ tenantId: tenant.id, kind: "service", scopes: ["documents:write"], displayName: "inbound-email" });
  db.addCustomer({ tenantId: tenant.id, name: "Acme", emailDomains: ["acme.com"] });
  const root: ApiStoreRoot = {
    resolvePrincipalByApiKeyHash: (h) => db.forTenant(tenant.id).resolvePrincipalByApiKeyHash(h),
    resolveInboundMailbox: (slug) => db.forTenant(tenant.id).resolveInboundMailbox(slug),
    forTenant: (id) => db.forTenant(id),
  };
  const queue = new MemoryJobQueue();
  const app = createApp({ registry: createDefaultRegistry(), store: root, objects: new MemoryObjectStore(), queue, globalPause: false, postmarkToken: "tok" });
  return { app, db, queue, tenant };
}

const json = (body: unknown, key: string) => ({ method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(body) });

describe("api", () => {
  it("requires a valid api key", async () => {
    const { app } = setup();
    expect((await app.request("/v1/tools")).status).toBe(401);
    expect((await app.request("/v1/tools", { headers: { authorization: "Bearer nope" } })).status).toBe(401);
    const ok = await app.request("/v1/tools", { headers: { authorization: "Bearer admin-key" } });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { tools: Array<{ name: string }> }).tools.map((t) => t.name)).toContain("find_customer");
  });

  it("invokes tools through the choke point and maps errors", async () => {
    const { app } = setup();
    const r = await app.request("/v1/tools/find_customer", json({ input: { email: "x@acme.com" } }, "agent-key"));
    expect(r.status).toBe(200);
    expect(((await r.json()) as { output: { best: { name: string } } }).output.best.name).toBe("Acme");
    const denied = await app.request("/v1/tools/match_product_line", json({ input: { qty: 1 } }, "agent-key"));
    expect(denied.status).toBe(403);
    const bad = await app.request("/v1/tools/find_customer", json({ input: { email: 5 } }, "admin-key"));
    expect(bad.status).toBe(400);
  });

  it("stores an uploaded document, ingests it idempotently and enqueues one run", async () => {
    const { app, db, queue } = setup();
    const body = { filename: "po.txt", mime: "text/plain", contentBase64: Buffer.from("please send 3 cases WID-100").toString("base64"), fromAddress: "buyer@acme.com" };
    const first = await app.request("/v1/documents", json(body, "admin-key"));
    expect(first.status).toBe(201);
    const second = await app.request("/v1/documents", json(body, "admin-key"));
    expect(second.status).toBe(200);
    expect(((await second.json()) as { created: boolean }).created).toBe(false);
    expect(db.documents).toHaveLength(1);
    expect(db.events.filter((e) => e.type === "document.received")).toHaveLength(1);
    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]).toMatchObject({ name: "intake.run", data: { senderEmail: "buyer@acme.com" } });
  });

  it("accepts Postmark inbound mail for a known mailbox and stores attachments under the email", async () => {
    const { app, db, queue } = setup();
    const payload = {
      MessageID: "m-1", From: "Bea <buyer@acme.com>", OriginalRecipient: "orders+acme@in.example.com", Subject: "PO 4711", TextBody: "see attached",
      Attachments: [{ Name: "po.pdf", Content: Buffer.from("%PDF-1.4").toString("base64"), ContentType: "application/pdf" }],
    };
    const nope = await app.request("/webhooks/postmark?token=wrong", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    expect(nope.status).toBe(401);
    const r = await app.request("/webhooks/postmark?token=tok", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    expect(r.status).toBe(200);
    const out = (await r.json()) as { documentIds: string[]; duplicate: boolean };
    expect(out.documentIds).toHaveLength(2);
    expect(db.documents.find((d) => d.kind === "pdf")?.parentDocumentId).toBe(out.documentIds[0]);
    expect(queue.jobs).toHaveLength(1);
    const again = await app.request("/webhooks/postmark?token=tok", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    expect(((await again.json()) as { duplicate: boolean }).duplicate).toBe(true);
    expect(queue.jobs).toHaveLength(1);
    const unknown = await app.request("/webhooks/postmark?token=tok", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...payload, MessageID: "m-2", OriginalRecipient: "orders+nobody@in.example.com" }) });
    expect(unknown.status).toBe(404);
  });
});
