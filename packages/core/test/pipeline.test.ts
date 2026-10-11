import { describe, expect, it } from "vitest";
import { createDefaultRegistry, createStepRunner, runOrderIntake, type IntakeEnv } from "../src/index.js";
import { FakeLlm, MemoryDb, extractedOrder } from "../src/testing/index.js";

function fixture(opts: { autonomyLevel?: 0 | 1 | 2; gateGreen?: boolean; autoCommit?: boolean } = {}) {
  const db = new MemoryDb();
  const tenant = db.addTenant({ autonomyLevel: opts.autonomyLevel ?? 1, settings: { defaultCurrency: "EUR" } });
  db.gates.set(tenant.id, opts.gateGreen ?? false);
  const agent = db.addPrincipal({ tenantId: tenant.id, kind: "agent", scopes: ["customers:read", "products:read", "orders:propose"], policy: { autoCommitEnabled: opts.autoCommit ?? false } });
  const acme = db.addCustomer({
    tenantId: tenant.id, name: "Acme Industrial", emailDomains: ["acme.com"], contacts: ["buyer@acme.com"],
    shipTo: [{ name: "Acme Dock 4", line1: "1 Industrial Way", line2: null, city: "Springfield", region: null, postalCode: "90210", country: "US" }],
  });
  const widget = db.addProduct({ tenantId: tenant.id, sku: "WID-100", name: "Widget 100mm steel", packFactors: { CS: 12 }, qtyAvailable: 500 });
  const bolt = db.addProduct({ tenantId: tenant.id, sku: "BOLT-5", name: "Hex bolt M5 zinc", qtyAvailable: 10 });
  db.addProduct({ tenantId: tenant.id, sku: "BOLT-6", name: "Hex bolt M6 zinc", qtyAvailable: 10 });
  db.defaultPriceLists.set(tenant.id, "pl-default");
  db.addPrice({ tenantId: tenant.id, priceListId: "pl-default", productId: widget.id, unitPrice: 4.5 });
  db.addPrice({ tenantId: tenant.id, priceListId: "pl-default", productId: bolt.id, unitPrice: 0.1 });
  const registry = createDefaultRegistry();
  const store = db.forTenant(tenant.id);
  const env = (llm: FakeLlm): IntakeEnv => ({ registry, store, llm, tenant, principal: agent, steps: createStepRunner({ store, runId: "run-1" }) });
  const docs = [{ id: "33333333-3333-4333-8333-333333333333", kind: "email" as const, filename: null, fromAddress: "buyer@acme.com", text: "please send 3 cases WID-100 and 100 BOLT-5", pdfBase64: null }];
  return { db, tenant, agent, acme, widget, bolt, registry, store, env, docs };
}

describe("order intake pipeline", () => {
  it("turns an email into a reviewable proposal with provenance", async () => {
    const f = fixture();
    const llm = new FakeLlm(extractedOrder({
      customer_po_number: "PO-4711",
      lines: [
        { raw_sku: "WID-100", raw_description: "Widget 100", qty: 3, raw_uom: "cases", stated_unit_price: 4.5, evidence: "3 cases WID-100" },
        { raw_sku: "BOLT-5", raw_description: null, qty: 100, raw_uom: null, stated_unit_price: 0.2, evidence: "100 BOLT-5" },
      ],
    }));
    const out = await runOrderIntake(f.env(llm), { documents: f.docs, senderEmail: "buyer@acme.com" });
    expect(out.kind).toBe("proposal");
    if (out.kind !== "proposal") return;
    expect(out.status).toBe("pending_approval");
    expect(out.draft.customerId).toBe(f.acme.id);
    expect(out.draft.currency).toBe("EUR");
    expect(out.draft.lines[0]).toMatchObject({ productId: f.widget.id, uom: "CS", qty: 3, unitPrice: 4.5, matchMethod: "sku_exact" });
    expect(out.draft.lines[1]?.flags).toEqual(expect.arrayContaining(["price_mismatch", "stock_short"]));
    expect(out.policyResult.decision).toBe("review");
    expect(out.policyResult.reasons.map((r) => r.code)).toContain("price_mismatch");
    expect(f.db.proposals).toHaveLength(1);
    expect(f.db.events.map((e) => e.type)).toContain("proposal.created");
    expect(f.db.provenance.some((p) => p.entityType === "proposal" && p.runId === "run-1" && p.sourceDocumentIds.includes(f.docs[0]!.id))).toBe(true);
    expect(f.db.runSteps.map((s) => s.name)).toEqual(expect.arrayContaining(["triage", "extract", "match_customer", "match_line_0", "price_line_0", "create_order_proposal"]));
    expect(llm.calls).toEqual(["triage", "extract"]);
  });

  it("is a no-op for non-orders", async () => {
    const f = fixture();
    const llm = new FakeLlm(extractedOrder());
    llm.triageResult = { is_order: false, order_bearing_document_indexes: [], language: "en", reason: "newsletter" };
    const out = await runOrderIntake(f.env(llm), { documents: f.docs, senderEmail: "buyer@acme.com" });
    expect(out).toEqual({ kind: "noop", reason: "newsletter" });
    expect(f.db.proposals).toHaveLength(0);
  });

  it("asks the model to pick among fuzzy candidates and marks the line as reviewed", async () => {
    const f = fixture();
    const llm = new FakeLlm(extractedOrder({ lines: [{ raw_sku: null, raw_description: "hex bolt M5", qty: 10, raw_uom: null, stated_unit_price: null, evidence: "hex bolt M5" }] }));
    const out = await runOrderIntake(f.env(llm), { documents: f.docs, senderEmail: "buyer@acme.com" });
    expect(llm.calls).toContain("disambiguateProduct");
    if (out.kind !== "proposal") throw new Error("expected proposal");
    expect(out.draft.lines[0]?.matchMethod).toBe("llm_pick");
    expect(out.draft.lines[0]?.productId).toBeTruthy();
    expect(out.status).toBe("pending_approval");
  });

  it("auto-approves only with autonomy level 2, agent auto-commit and a green gate", async () => {
    const clean = extractedOrder({ customer_po_number: "PO-1", lines: [{ raw_sku: "WID-100", raw_description: null, qty: 2, raw_uom: "cs", stated_unit_price: null, evidence: "x" }] });
    const red = fixture({ autonomyLevel: 2, gateGreen: false, autoCommit: true });
    const r1 = await runOrderIntake(red.env(new FakeLlm(clean)), { documents: red.docs, senderEmail: "buyer@acme.com" });
    if (r1.kind !== "proposal") throw new Error("expected proposal");
    expect(r1.policyResult.decision).toBe("auto");
    expect(r1.status).toBe("pending_approval");
    expect(r1.policyResult.reasons.map((r) => r.code)).toContain("autonomy_not_enabled");

    const green = fixture({ autonomyLevel: 2, gateGreen: true, autoCommit: true });
    const r2 = await runOrderIntake(green.env(new FakeLlm(clean)), { documents: green.docs, senderEmail: "buyer@acme.com" });
    if (r2.kind !== "proposal") throw new Error("expected proposal");
    expect(r2.status).toBe("auto_approved");
  });

  it("blocks when the customer cannot be resolved", async () => {
    const f = fixture();
    const out = await runOrderIntake(f.env(new FakeLlm(extractedOrder({ lines: [{ raw_sku: "WID-100", raw_description: null, qty: 1, raw_uom: null, stated_unit_price: null, evidence: "x" }] }))), { documents: f.docs, senderEmail: "stranger@nowhere.io" });
    if (out.kind !== "proposal") throw new Error("expected proposal");
    expect(out.status).toBe("checks_failed");
    expect(out.draft.flags).toContain("customer_unresolved");
  });
});
