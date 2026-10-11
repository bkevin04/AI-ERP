import { describe, expect, it } from "vitest";
import { applyPick, matchCustomer, matchProductLine, normalizeUom, resolveLineUom } from "../src/index.js";
import { MemoryDb } from "../src/testing/index.js";

function fixture() {
  const db = new MemoryDb();
  const tenant = db.addTenant();
  const acme = db.addCustomer({ tenantId: tenant.id, name: "Acme Industrial Supply", emailDomains: ["acme.com"], contacts: ["buyer@acme.com"], billingPostalCode: "90210" });
  const globex = db.addCustomer({ tenantId: tenant.id, name: "Globex Corporation", emailDomains: ["globex.com"] });
  const globexWest = db.addCustomer({ tenantId: tenant.id, name: "Globex West", emailDomains: ["globex.com"] });
  const widget = db.addProduct({ tenantId: tenant.id, sku: "WID-100", name: "Widget 100mm steel", barcode: "4006381333931", packFactors: { CS: 12 } });
  const bolt = db.addProduct({ tenantId: tenant.id, sku: "BOLT-5", name: "Hex bolt M5 zinc" });
  const nut = db.addProduct({ tenantId: tenant.id, sku: "NUT-5", name: "Hex nut M5 zinc" });
  db.addAlias({ tenantId: tenant.id, productId: bolt.id, customerId: acme.id, alias: "ACME-77" });
  db.addAlias({ tenantId: tenant.id, productId: nut.id, customerId: null, alias: "m5 nut", aliasType: "synonym" });
  return { db, tenant, store: db.forTenant(tenant.id), acme, globex, globexWest, widget, bolt, nut };
}

describe("matchCustomer", () => {
  it("contact email is decisive", async () => {
    const f = fixture();
    const m = await matchCustomer(f.store, { senderEmail: "Buyer@acme.com" });
    expect(m.best).toMatchObject({ customerId: f.acme.id, score: 0.95, method: "contact_email" });
  });
  it("unique sender domain is decisive", async () => {
    const f = fixture();
    const m = await matchCustomer(f.store, { senderEmail: "someone@acme.com" });
    expect(m.best).toMatchObject({ customerId: f.acme.id, score: 0.85, method: "sender_domain" });
  });
  it("shared domain yields candidates, not a match", async () => {
    const f = fixture();
    const m = await matchCustomer(f.store, { senderEmail: "x@globex.com" });
    expect(m.best).toBeNull();
    expect(m.candidates.map((c) => c.customerId).sort()).toEqual([f.globex.id, f.globexWest.id].sort());
  });
  it("freemail domains are ignored; name plus postal code matches", async () => {
    const f = fixture();
    const m = await matchCustomer(f.store, { senderEmail: "bob@gmail.com", name: "ACME Industrial Supply Inc", postalCode: "90210" });
    expect(m.best).toMatchObject({ customerId: f.acme.id, method: "name_postal" });
  });
  it("returns nothing for an unknown sender", async () => {
    const f = fixture();
    const m = await matchCustomer(f.store, { senderEmail: "nobody@unknown.io", name: "Zzzz Ltd" });
    expect(m.best).toBeNull();
    expect(m.candidates).toHaveLength(0);
  });
});

describe("matchProductLine", () => {
  it("customer alias beats everything", async () => {
    const f = fixture();
    const m = await matchProductLine(f.store, { customerId: f.acme.id, rawSku: "ACME-77", rawDescription: null, qty: 10, rawUom: null });
    expect(m.best).toMatchObject({ productId: f.bolt.id, method: "customer_alias", score: 0.98 });
  });
  it("another customer's alias does not apply", async () => {
    const f = fixture();
    const m = await matchProductLine(f.store, { customerId: f.globex.id, rawSku: "ACME-77", rawDescription: null, qty: 10, rawUom: null });
    expect(m.best).toBeNull();
  });
  it("normalised sku and barcode match", async () => {
    const f = fixture();
    const bySku = await matchProductLine(f.store, { customerId: null, rawSku: "wid 100", rawDescription: null, qty: 1, rawUom: "ea" });
    expect(bySku.best).toMatchObject({ productId: f.widget.id, method: "sku_exact" });
    const byBarcode = await matchProductLine(f.store, { customerId: null, rawSku: "4006381333931", rawDescription: null, qty: 1, rawUom: null });
    expect(byBarcode.best).toMatchObject({ productId: f.widget.id, method: "barcode" });
  });
  it("tenant-wide alias matches by description", async () => {
    const f = fixture();
    const m = await matchProductLine(f.store, { customerId: null, rawSku: null, rawDescription: "M5 Nut", qty: 100, rawUom: null });
    expect(m.best).toMatchObject({ productId: f.nut.id, method: "tenant_alias" });
  });
  it("fuzzy text yields candidates with no decision", async () => {
    const f = fixture();
    const m = await matchProductLine(f.store, { customerId: null, rawSku: null, rawDescription: "hex bolt m5", qty: 5, rawUom: null });
    expect(m.best).toBeNull();
    expect(m.candidates.length).toBeGreaterThan(0);
    expect(m.flags).toContain("unmatched_product");
    const picked = applyPick(m, { productId: f.bolt.id, product: f.bolt }, { customerId: null, rawSku: null, rawDescription: "hex bolt m5", qty: 5, rawUom: null });
    expect(picked.best).toMatchObject({ productId: f.bolt.id, method: "llm_pick" });
    expect(picked.flags).not.toContain("unmatched_product");
    const abstained = applyPick(m, null, { customerId: null, rawSku: null, rawDescription: "hex bolt m5", qty: 5, rawUom: null });
    expect(abstained.flags).toContain("llm_abstained");
  });
  it("keeps a pack unit the product knows, flags one it does not", async () => {
    const f = fixture();
    const cases = await matchProductLine(f.store, { customerId: null, rawSku: "WID-100", rawDescription: null, qty: 3, rawUom: "cases" });
    expect(cases.uom).toBe("CS");
    expect(cases.flags).toEqual([]);
    const boxes = await matchProductLine(f.store, { customerId: null, rawSku: "WID-100", rawDescription: null, qty: 3, rawUom: "box" });
    expect(boxes.uom).toBe("EA");
    expect(boxes.flags).toContain("uom_pack_mismatch");
  });
});

describe("uom", () => {
  it("normalises synonyms", () => {
    expect(normalizeUom("Pcs.")).toBe("EA");
    expect(normalizeUom("Carton")).toBe("CS");
    expect(normalizeUom("blorp")).toBeNull();
    expect(normalizeUom(null)).toBeNull();
  });
  it("flags unknown units and fractional discrete quantities", () => {
    expect(resolveLineUom("blorp", 2, { baseUom: "EA", packFactors: {} }).flags).toContain("uom_unknown");
    expect(resolveLineUom("ea", 2.5, { baseUom: "EA", packFactors: {} }).flags).toContain("qty_suspicious");
    expect(resolveLineUom("kg", 2.5, { baseUom: "KG", packFactors: {} }).flags).toEqual([]);
    expect(resolveLineUom(null, 0, { baseUom: "EA", packFactors: {} }).flags).toContain("qty_suspicious");
  });
});
