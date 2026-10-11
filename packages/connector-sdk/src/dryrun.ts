import type { CanonicalOrder, ExtCustomer, ExtOrderRef, ExtOrderStatus, ExtPriceList, ExtProduct, ExtStock } from "@ai-erp/contracts";
import type { ErpConnector } from "./connector.js";

export interface DryRunFixtures {
  customers?: ExtCustomer[];
  products?: ExtProduct[];
  priceLists?: ExtPriceList[];
  stock?: ExtStock[];
}

/** Records every request instead of sending it. Used for sandbox tenants and tests. */
export class DryRunConnector implements ErpConnector {
  readonly kind = "dryrun" as const;
  readonly pushed: Array<{ order: CanonicalOrder; idempotencyKey: string; ref: ExtOrderRef }> = [];

  constructor(private readonly fixtures: DryRunFixtures = {}) {}

  async testConnection() {
    return { ok: true, detail: "dry-run" };
  }
  async *pullCustomers() { yield* this.fixtures.customers ?? []; }
  async *pullProducts() { yield* this.fixtures.products ?? []; }
  async *pullPriceLists() { yield* this.fixtures.priceLists ?? []; }
  async *pullStock() { yield* this.fixtures.stock ?? []; }
  async findOrderByClientRef(ref: string): Promise<ExtOrderRef | null> {
    return this.pushed.find((p) => p.order.orderNumber === ref)?.ref ?? null;
  }
  async pushOrder(order: CanonicalOrder, idempotencyKey: string): Promise<ExtOrderRef> {
    const ref = { externalId: `dry-${this.pushed.length + 1}`, externalNumber: `DRY${String(this.pushed.length + 1).padStart(5, "0")}` };
    this.pushed.push({ order, idempotencyKey, ref });
    return ref;
  }
  async readOrderStatus(externalId: string): Promise<ExtOrderStatus> {
    const hit = this.pushed.find((p) => p.ref.externalId === externalId);
    return { externalId, state: hit ? "confirmed" : "unknown", raw: {} };
  }
}
