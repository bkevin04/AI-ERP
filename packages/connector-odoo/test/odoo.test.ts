import { describe, expect, it } from "vitest";
import { OdooConnector } from "../src/index.js";

type Call = { model: string; method: string; args: unknown[]; kwargs: Record<string, unknown> };

function fakeOdoo(handlers: (call: Call) => unknown) {
  const calls: Call[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: number; params: { service: string; method: string; args: unknown[] } };
    let result: unknown;
    if (body.params.service === "common") result = 2;
    else {
      const [, , , model, method, args, kwargs] = body.params.args as [string, number, string, string, string, unknown[], Record<string, unknown>];
      const call = { model, method, args, kwargs };
      calls.push(call);
      result = handlers(call);
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, connector: new OdooConnector({ url: "http://odoo", db: "odoo", username: "admin", apiKey: "k", fetchImpl }) };
}

describe("OdooConnector", () => {
  it("maps partners with contacts into customers with email domains", async () => {
    const { connector } = fakeOdoo(({ model, args }) => {
      if (model === "res.partner" && JSON.stringify(args).includes("is_company")) {
        return [{ id: 7, name: "Acme", email: "info@acme.com", street: "1 Way", street2: false, city: "Springfield", zip: "90210", state_id: false, country_id: [1, "United States"], property_payment_term_id: [3, "30 Days"], active: true }];
      }
      return [{ id: 8, name: "Bea Buyer", email: "bea@gmail.com", parent_id: [7, "Acme"] }];
    });
    const customers = [];
    for await (const c of connector.pullCustomers()) customers.push(c);
    expect(customers).toHaveLength(1);
    expect(customers[0]).toMatchObject({ externalId: "7", name: "Acme", emailDomains: ["acme.com"], paymentTerms: "30 Days" });
    expect(customers[0]!.contacts).toEqual([{ externalId: "8", email: "bea@gmail.com", name: "Bea Buyer" }]);
    expect(customers[0]!.shipTo[0]).toMatchObject({ line1: "1 Way", postalCode: "90210", country: "United States" });
  });

  it("pushes with search-before-create semantics available and reads status", async () => {
    const created: Record<string, unknown>[] = [];
    const { connector, calls } = fakeOdoo(({ model, method, args }) => {
      if (model === "sale.order" && method === "create") { created.push(args[0] as Record<string, unknown>); return 99; }
      if (model === "sale.order" && method === "search_read") {
        const domain = JSON.stringify(args[0]);
        if (domain.includes("client_order_ref")) return [];
        return [{ id: 99, name: "S00099", state: "sale", client_order_ref: "SO-1" }];
      }
      if (model === "uom.uom") return [{ id: 1 }];
      return [];
    });
    expect(await connector.findOrderByClientRef("SO-1")).toBeNull();
    const ref = await connector.pushOrder({ orderNumber: "SO-1", customerExternalId: "7", customerPoNumber: "PO-1", requestedDate: "2026-10-20", currency: "USD", shipTo: null, lines: [{ productExternalId: "42", description: "Widget", qty: 2, uom: "EA", unitPrice: 4.5 }] }, "k");
    expect(ref).toEqual({ externalId: "99", externalNumber: "S00099" });
    expect(created[0]).toMatchObject({ partner_id: 7, client_order_ref: "SO-1", origin: "PO-1", commitment_date: "2026-10-20 00:00:00" });
    expect((created[0]!["order_line"] as unknown[])[0]).toEqual([0, 0, { product_id: 42, product_uom_qty: 2, name: "Widget", price_unit: 4.5, product_uom: 1 }]);
    expect(await connector.readOrderStatus("99")).toMatchObject({ state: "confirmed" });
    expect(calls.some((c) => c.model === "sale.order" && c.method === "create")).toBe(true);
  });
});
