import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgCoreStore } from "../src/store.js";
import { createTestDatabase } from "../src/testing.js";

let env: Awaited<ReturnType<typeof createTestDatabase>>;
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const agentA = "aaaaaaaa-0000-4000-8000-000000000001";
const humanB = "bbbbbbbb-0000-4000-8000-000000000001";

beforeAll(async () => {
  env = await createTestDatabase();
  // Fixtures are loaded as the owner (RLS bypassed), like a migration or seed would.
  await env.pg.exec(`
    INSERT INTO tenants (id, slug, name, autonomy_level) VALUES ('${A}', 'a', 'Tenant A', 2), ('${B}', 'b', 'Tenant B', 1);
    INSERT INTO principals (id, tenant_id, kind, display_name) VALUES ('${agentA}', '${A}', 'agent', 'intake-bot'), ('${humanB}', '${B}', 'human', 'Bea');
    INSERT INTO agent_policies (tenant_id, principal_id, allowed_tools, auto_commit_enabled, max_auto_order_value, rate_limit_per_hour)
      VALUES ('${A}', '${agentA}', ARRAY['find_customer'], true, 1500.50, 100);
    INSERT INTO roles (id, tenant_id, name) VALUES ('aaaaaaaa-0000-4000-8000-00000000r001', '${A}', 'intake');
    INSERT INTO role_scopes (tenant_id, role_id, scope) VALUES ('${A}', 'aaaaaaaa-0000-4000-8000-00000000r001', 'customers:read'), ('${A}', 'aaaaaaaa-0000-4000-8000-00000000r001', 'orders:propose');
    INSERT INTO principal_roles (tenant_id, principal_id, role_id) VALUES ('${A}', '${agentA}', 'aaaaaaaa-0000-4000-8000-00000000r001');
    INSERT INTO api_keys (tenant_id, principal_id, key_hash, scopes) VALUES ('${A}', '${agentA}', 'hash-a', ARRAY['products:read']), ('${B}', '${humanB}', 'hash-b', ARRAY['admin']);
    INSERT INTO customers (id, tenant_id, name, normalized_name, email_domains, billing_address)
      VALUES ('aaaaaaaa-0000-4000-8000-00000000c001', '${A}', 'Acme Industrial Supply', 'acme industrial supply', ARRAY['acme.com'], '{"postalCode":"90210"}'),
             ('bbbbbbbb-0000-4000-8000-00000000c001', '${B}', 'Acme Industrial Supply', 'acme industrial supply', ARRAY['acme.com'], NULL);
    INSERT INTO customer_contacts (tenant_id, customer_id, email) VALUES ('${A}', 'aaaaaaaa-0000-4000-8000-00000000c001', 'buyer@acme.com');
    INSERT INTO products (id, tenant_id, sku, sku_norm, name, description, barcode, pack_factors, list_price)
      VALUES ('aaaaaaaa-0000-4000-8000-00000000d001', '${A}', 'WID-100', 'WID100', 'Widget 100mm steel', 'galvanised widget', '4006381333931', '{"CS":12}', 4.5),
             ('aaaaaaaa-0000-4000-8000-00000000d002', '${A}', 'BOLT-5', 'BOLT5', 'Hex bolt M5 zinc', NULL, NULL, '{}', NULL);
    INSERT INTO price_lists (id, tenant_id, name, currency, is_default) VALUES ('aaaaaaaa-0000-4000-8000-00000000e101', '${A}', 'Standard', 'USD', true);
    INSERT INTO price_list_items (tenant_id, price_list_id, product_id, min_qty, unit_price) VALUES ('${A}', 'aaaaaaaa-0000-4000-8000-00000000e101', 'aaaaaaaa-0000-4000-8000-00000000d002', 0, 0.12), ('${A}', 'aaaaaaaa-0000-4000-8000-00000000e101', 'aaaaaaaa-0000-4000-8000-00000000d002', 100, 0.10);
    INSERT INTO stock_snapshots (tenant_id, product_id, location, qty_available) VALUES ('${A}', 'aaaaaaaa-0000-4000-8000-00000000d001', 'main', 40), ('${A}', 'aaaaaaaa-0000-4000-8000-00000000d001', 'overflow', 2);
  `.replace(/00000000r001/g, "000000000101"));
}, 60_000);

afterAll(async () => {
  await env?.close();
});

const storeA = () => new PgCoreStore(env.db, A, { assumeRole: "app_user" });
const storeB = () => new PgCoreStore(env.db, B, { assumeRole: "app_user" });

describe("row-level security", () => {
  it("scopes reads to the tenant in context", async () => {
    expect((await storeA().findCustomersByDomain("acme.com")).map((c) => c.id)).toEqual(["aaaaaaaa-0000-4000-8000-00000000c001"]);
    expect((await storeB().findCustomersByDomain("acme.com")).map((c) => c.id)).toEqual(["bbbbbbbb-0000-4000-8000-00000000c001"]);
    expect(await storeB().findCustomersByContactEmail("buyer@acme.com")).toEqual([]);
  });

  it("rejects inserts that name another tenant", async () => {
    await expect(
      env.pg.transaction(async (tx) => {
        await tx.exec(`SET LOCAL ROLE app_user; SELECT set_config('app.tenant_id', '${A}', true);`);
        await tx.query(`INSERT INTO documents (tenant_id, kind, storage_key, sha256, mime) VALUES ($1, 'pdf', 'k', $2, 'application/pdf')`, [B, "x".repeat(64)]);
      }),
    ).rejects.toThrow(/row-level security/);
  });

  it("hides the tenant row of other tenants", async () => {
    expect(await storeA().getTenant(A)).toMatchObject({ id: A, autonomyLevel: 2 });
    expect(await storeA().getTenant(B)).toBeNull();
  });
});

describe("append-only tables", () => {
  it("app_user cannot update or delete events; even the owner is stopped by the trigger", async () => {
    const r = await storeA().insertEvent({ id: "aaaaaaaa-0000-4000-8000-00000000e001", type: "document.received", payload: {}, idempotencyKey: "k1" });
    expect(r.created).toBe(true);
    const again = await storeA().insertEvent({ id: "aaaaaaaa-0000-4000-8000-00000000e002", type: "document.received", payload: {}, idempotencyKey: "k1" });
    expect(again).toEqual({ id: "aaaaaaaa-0000-4000-8000-00000000e001", created: false });
    await expect(
      env.pg.transaction(async (tx) => {
        await tx.exec(`SET LOCAL ROLE app_user; SELECT set_config('app.tenant_id', '${A}', true);`);
        await tx.exec(`UPDATE events SET type = 'x'`);
      }),
    ).rejects.toThrow(/permission denied|append-only/);
    await expect(env.pg.exec(`DELETE FROM events`)).rejects.toThrow(/append-only/);
  });
});

describe("api keys and principals", () => {
  it("resolves a key without tenant context and merges key and role scopes", async () => {
    const p = await storeA().resolvePrincipalByApiKeyHash("hash-a");
    expect(p).toMatchObject({ id: agentA, tenantId: A, kind: "agent" });
    expect([...p!.scopes].sort()).toEqual(["customers:read", "orders:propose", "products:read"]);
    expect(p!.policy).toMatchObject({ allowedTools: ["find_customer"], autoCommitEnabled: true, maxAutoOrderValue: 1500.5, rateLimitPerHour: 100 });
    expect(await storeA().resolvePrincipalByApiKeyHash("nope")).toBeNull();
    expect(await storeA().getPrincipal(humanB)).toBeNull();
  });
});

describe("matching queries", () => {
  it("trigram name search, sku, barcode, product search", async () => {
    const hits = await storeA().searchCustomersByName("ACME Industrial", 5);
    expect(hits[0]?.customer.id).toBe("aaaaaaaa-0000-4000-8000-00000000c001");
    expect(hits[0]!.similarity).toBeGreaterThan(0.5);
    expect((await storeA().findProductBySku("WID100"))?.name).toBe("Widget 100mm steel");
    expect((await storeA().findProductByBarcode("4006381333931"))?.sku).toBe("WID-100");
    const search = await storeA().searchProducts("hex bolt m5", 5);
    expect(search[0]?.product.sku).toBe("BOLT-5");
  });

  it("prices with quantity breaks, falls back to list price, sums stock across locations", async () => {
    expect(await storeA().resolvePrice(null, "aaaaaaaa-0000-4000-8000-00000000d002", 10)).toMatchObject({ unitPrice: 0.12, source: "tenant_default" });
    expect(await storeA().resolvePrice(null, "aaaaaaaa-0000-4000-8000-00000000d002", 250)).toMatchObject({ unitPrice: 0.1 });
    expect(await storeA().resolvePrice(null, "aaaaaaaa-0000-4000-8000-00000000d001", 1)).toMatchObject({ unitPrice: 4.5, source: "list_price" });
    expect(await storeA().getStock("aaaaaaaa-0000-4000-8000-00000000d001")).toEqual({ qtyAvailable: 42 });
    expect(await storeA().getStock("aaaaaaaa-0000-4000-8000-00000000d002")).toBeNull();
  });
});

describe("ledger", () => {
  it("stores idempotent results, run steps and provenance inside one transaction", async () => {
    const store = storeA();
    await store.transaction(A, async (tx) => {
      await tx.insertAgentRun({ id: "aaaaaaaa-0000-4000-8000-00000000a001", principalId: agentA, triggerEventId: null, workflow: "order_intake", status: "running" });
      await tx.insertRunStep({ id: "aaaaaaaa-0000-4000-8000-00000000f001", runId: "aaaaaaaa-0000-4000-8000-00000000a001", seq: 1, kind: "code", name: "x", input: { a: 1 }, output: { b: 2 }, idempotencyKey: "step-1", status: "ok", durationMs: 3 });
      await tx.saveIdempotentResult({ principalId: agentA, tool: "t", key: "k", requestHash: "h", result: { ok: true } });
      await tx.insertProvenance([{ id: "aaaaaaaa-0000-4000-8000-00000000ab01", entityType: "proposal", entityId: "p", entityVersion: 1, action: "proposal.created", runId: "aaaaaaaa-0000-4000-8000-00000000a001", stepId: null, proposalId: null, approvalId: null, policyVersion: "v1", promptVersion: null, modelId: null, sourceDocumentIds: [], actorPrincipalId: agentA, diff: { x: 1 } }]);
    });
    expect(await storeA().findRunStep("aaaaaaaa-0000-4000-8000-00000000a001", "step-1")).toMatchObject({ seq: 1, output: { b: 2 } });
    expect(await storeA().getIdempotentResult(agentA, "t", "k")).toEqual({ requestHash: "h", result: { ok: true } });
    expect(await storeB().getIdempotentResult(agentA, "t", "k")).toBeNull();
  });
});
