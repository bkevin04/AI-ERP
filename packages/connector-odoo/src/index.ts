import type { Address, CanonicalOrder, ExtCustomer, ExtOrderRef, ExtOrderStatus, ExtPriceList, ExtProduct, ExtStock } from "@ai-erp/contracts";
import type { ErpConnector } from "@ai-erp/connector-sdk";
import { emailDomain, isFreemailDomain } from "@ai-erp/core";
import { OdooClient, type OdooConfig } from "./jsonrpc.js";

export { OdooClient, OdooRpcError, type OdooConfig } from "./jsonrpc.js";

type Many2one = [number, string] | false;

interface OdooPartner {
  id: number; name: string; email: string | false; street: string | false; street2: string | false; city: string | false;
  zip: string | false; state_id: Many2one; country_id: Many2one; property_payment_term_id: Many2one; active: boolean;
}
interface OdooContact { id: number; name: string; email: string | false; parent_id: Many2one }
interface OdooProduct {
  id: number; default_code: string | false; name: string; description_sale: string | false; barcode: string | false;
  uom_id: Many2one; list_price: number; active: boolean; qty_available: number; product_tmpl_id: Many2one;
}
interface OdooPricelist { id: number; name: string; currency_id: Many2one }
interface OdooPricelistItem {
  id: number; pricelist_id: Many2one; applied_on: string; product_id: Many2one; product_tmpl_id: Many2one;
  compute_price: string; fixed_price: number; min_quantity: number;
}
interface OdooSaleOrder { id: number; name: string; state: string; client_order_ref: string | false }

const str = (v: string | false | null | undefined): string | null => (v ? String(v) : null);

function partnerAddress(p: OdooPartner): Address | null {
  if (!p.street && !p.city) return null;
  return {
    name: p.name, line1: str(p.street) ?? "", line2: str(p.street2), city: str(p.city) ?? "",
    region: p.state_id ? p.state_id[1] : null, postalCode: str(p.zip) ?? "", country: p.country_id ? p.country_id[1] : "",
  };
}

/**
 * Odoo Community 17 over JSON-RPC. Mapping:
 *   res.partner (is_company)      -> ExtCustomer (+ child contacts)
 *   product.product (sale_ok)     -> ExtProduct, qty_available -> ExtStock
 *   product.pricelist(.item)      -> ExtPriceList (fixed prices only)
 *   sale.order                    -> pushOrder / readOrderStatus, client_order_ref = our order number
 */
export class OdooConnector implements ErpConnector {
  readonly kind = "odoo" as const;
  readonly client: OdooClient;
  private uomCache = new Map<string, number | null>();

  constructor(cfg: OdooConfig) {
    this.client = new OdooClient(cfg);
  }

  async testConnection() {
    try {
      const uid = await this.client.login();
      return { ok: true, detail: `uid ${uid}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  async *pullCustomers(): AsyncIterable<ExtCustomer> {
    const partners = await this.client.searchRead<OdooPartner>("res.partner", [["is_company", "=", true]],
      ["name", "email", "street", "street2", "city", "zip", "state_id", "country_id", "property_payment_term_id", "active"], { context: { active_test: false } });
    const ids = partners.map((p) => p.id);
    const contacts = ids.length
      ? await this.client.searchRead<OdooContact>("res.partner", [["parent_id", "in", ids]], ["name", "email", "parent_id"])
      : [];
    const byParent = new Map<number, OdooContact[]>();
    for (const c of contacts) if (c.parent_id) byParent.set(c.parent_id[0], [...(byParent.get(c.parent_id[0]) ?? []), c]);

    for (const p of partners) {
      const mine = byParent.get(p.id) ?? [];
      const domains = new Set<string>();
      for (const email of [p.email, ...mine.map((c) => c.email)]) {
        const d = emailDomain(email || null);
        if (d && !isFreemailDomain(d)) domains.add(d);
      }
      const address = partnerAddress(p);
      yield {
        externalId: String(p.id), name: p.name, email: str(p.email), emailDomains: [...domains], billingAddress: address,
        shipTo: address ? [address] : [],
        contacts: mine.map((c) => ({ externalId: String(c.id), email: str(c.email), name: c.name })),
        paymentTerms: p.property_payment_term_id ? p.property_payment_term_id[1] : null, active: p.active,
      };
    }
  }

  private async products(): Promise<OdooProduct[]> {
    return this.client.searchRead<OdooProduct>("product.product", [["sale_ok", "=", true]],
      ["default_code", "name", "description_sale", "barcode", "uom_id", "list_price", "active", "qty_available", "product_tmpl_id"]);
  }

  async *pullProducts(): AsyncIterable<ExtProduct> {
    for (const p of await this.products()) {
      yield {
        externalId: String(p.id), sku: str(p.default_code) ?? `ODOO-${p.id}`, name: p.name, description: str(p.description_sale),
        barcode: str(p.barcode), uom: p.uom_id ? normaliseOdooUom(p.uom_id[1]) : "EA", listPrice: p.list_price ?? null, active: p.active,
      };
    }
  }

  async *pullPriceLists(): AsyncIterable<ExtPriceList> {
    const lists = await this.client.searchRead<OdooPricelist>("product.pricelist", [], ["name", "currency_id"]);
    const items = await this.client.searchRead<OdooPricelistItem>("product.pricelist.item", [["compute_price", "=", "fixed"]],
      ["pricelist_id", "applied_on", "product_id", "product_tmpl_id", "compute_price", "fixed_price", "min_quantity"]);
    const variantsByTemplate = new Map<number, number[]>();
    for (const p of await this.products()) if (p.product_tmpl_id) variantsByTemplate.set(p.product_tmpl_id[0], [...(variantsByTemplate.get(p.product_tmpl_id[0]) ?? []), p.id]);
    for (const l of lists) {
      const mine = items.filter((i) => i.pricelist_id && i.pricelist_id[0] === l.id);
      const out: ExtPriceList["items"] = [];
      for (const i of mine) {
        const productIds = i.applied_on === "0_product_variant" && i.product_id ? [i.product_id[0]]
          : i.applied_on === "1_product" && i.product_tmpl_id ? (variantsByTemplate.get(i.product_tmpl_id[0]) ?? []) : [];
        for (const pid of productIds) out.push({ productExternalId: String(pid), minQty: i.min_quantity ?? 0, unitPrice: i.fixed_price, uom: null });
      }
      yield { externalId: String(l.id), name: l.name, currency: l.currency_id ? l.currency_id[1] : "USD", items: out };
    }
  }

  async *pullStock(productExternalIds?: string[]): AsyncIterable<ExtStock> {
    const wanted = productExternalIds ? new Set(productExternalIds) : null;
    const asOf = new Date();
    for (const p of await this.products()) {
      if (wanted && !wanted.has(String(p.id))) continue;
      yield { productExternalId: String(p.id), location: "odoo", qtyAvailable: p.qty_available ?? 0, asOf };
    }
  }

  async findOrderByClientRef(ref: string): Promise<ExtOrderRef | null> {
    const rows = await this.client.searchRead<OdooSaleOrder>("sale.order", [["client_order_ref", "=", ref]], ["name", "state"], { limit: 1 });
    return rows[0] ? { externalId: String(rows[0].id), externalNumber: rows[0].name } : null;
  }

  private async uomId(code: string): Promise<number | null> {
    if (this.uomCache.has(code)) return this.uomCache.get(code)!;
    const candidates: Record<string, string[]> = { EA: ["Units", "Unit"], CS: ["Case"], BX: ["Box"], DZ: ["Dozen", "Dozens"], KG: ["kg"], G: ["g"], L: ["L"], M: ["m"], PK: ["Pack"] };
    let id: number | null = null;
    for (const name of candidates[code] ?? [code]) {
      const rows = await this.client.searchRead<{ id: number }>("uom.uom", [["name", "=ilike", name]], ["id"], { limit: 1 });
      if (rows[0]) { id = rows[0].id; break; }
    }
    this.uomCache.set(code, id);
    return id;
  }

  async pushOrder(order: CanonicalOrder, _idempotencyKey: string): Promise<ExtOrderRef> {
    const lines: unknown[] = [];
    for (const l of order.lines) {
      const vals: Record<string, unknown> = { product_id: Number(l.productExternalId), product_uom_qty: l.qty, name: l.description };
      if (l.unitPrice !== null) vals["price_unit"] = l.unitPrice;
      if (l.uom) { const uom = await this.uomId(l.uom); if (uom) vals["product_uom"] = uom; }
      lines.push([0, 0, vals]);
    }
    const values: Record<string, unknown> = {
      partner_id: Number(order.customerExternalId), client_order_ref: order.orderNumber, order_line: lines,
      origin: order.customerPoNumber ?? undefined,
    };
    if (order.requestedDate) values["commitment_date"] = `${order.requestedDate} 00:00:00`;
    const id = await this.client.create("sale.order", values);
    const rows = await this.client.searchRead<OdooSaleOrder>("sale.order", [["id", "=", id]], ["name"], { limit: 1 });
    return { externalId: String(id), externalNumber: rows[0]?.name ?? null };
  }

  async readOrderStatus(externalId: string): Promise<ExtOrderStatus> {
    const rows = await this.client.searchRead<OdooSaleOrder>("sale.order", [["id", "=", Number(externalId)]], ["name", "state", "client_order_ref"], { limit: 1 });
    const row = rows[0];
    const state = !row ? "unknown" : row.state === "sale" ? "confirmed" : row.state === "done" ? "done" : row.state === "cancel" ? "cancelled" : "draft";
    return { externalId, state, raw: (row as unknown as Record<string, unknown>) ?? {} };
  }
}

function normaliseOdooUom(name: string): string {
  const n = name.toLowerCase();
  if (n.startsWith("unit")) return "EA";
  if (n.startsWith("dozen")) return "DZ";
  if (n.startsWith("case")) return "CS";
  if (n.startsWith("box")) return "BX";
  if (n.startsWith("pack")) return "PK";
  return name.toUpperCase().slice(0, 4);
}
