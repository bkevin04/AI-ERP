import { describe, expect, it } from "vitest";
import { DryRunConnector, InMemoryMasterDataSink, pushOrderIdempotent, syncMasterData } from "../src/index.js";

const customer = { externalId: "7", name: "Acme", email: "po@acme.com", emailDomains: ["acme.com"], billingAddress: null, shipTo: [], contacts: [], paymentTerms: null, active: true };
const product = { externalId: "42", sku: "WID-100", name: "Widget", description: null, barcode: null, uom: "EA", listPrice: 4.5, active: true };

describe("syncMasterData", () => {
  it("creates, then reports unchanged, then updates on content change", async () => {
    const sink = new InMemoryMasterDataSink();
    const first = await syncMasterData(new DryRunConnector({ customers: [customer], products: [product] }), sink);
    expect(first.customers).toEqual({ created: 1, updated: 0, unchanged: 0 });
    expect(first.products.created).toBe(1);
    const second = await syncMasterData(new DryRunConnector({ customers: [customer], products: [product] }), sink);
    expect(second.customers.unchanged).toBe(1);
    const third = await syncMasterData(new DryRunConnector({ customers: [{ ...customer, name: "Acme Ltd" }], products: [product] }), sink);
    expect(third.customers.updated).toBe(1);
    expect(third.errors).toEqual([]);
  });
});

describe("pushOrderIdempotent", () => {
  it("creates once and finds the existing order on retry", async () => {
    const c = new DryRunConnector();
    const order = { orderNumber: "SO-1", customerExternalId: "7", customerPoNumber: "PO-1", requestedDate: null, currency: "USD", shipTo: null, lines: [{ productExternalId: "42", description: "Widget", qty: 2, uom: "EA", unitPrice: 4.5 }] };
    const a = await pushOrderIdempotent(c, order, "k");
    const b = await pushOrderIdempotent(c, order, "k");
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.ref).toEqual(a.ref);
    expect(c.pushed).toHaveLength(1);
  });
});
