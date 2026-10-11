import type { CanonicalOrder, ConnectorKind, ExtCustomer, ExtOrderRef, ExtOrderStatus, ExtPriceList, ExtProduct, ExtStock } from "@ai-erp/contracts";

/**
 * The one interface every ERP integration implements. `core` and the pipeline never
 * see Odoo, Business Central or QuickBooks specifics.
 */
export interface ErpConnector {
  readonly kind: ConnectorKind;
  testConnection(): Promise<{ ok: boolean; detail?: string }>;
  pullCustomers(): AsyncIterable<ExtCustomer>;
  pullProducts(): AsyncIterable<ExtProduct>;
  pullPriceLists(): AsyncIterable<ExtPriceList>;
  pullStock(productExternalIds?: string[]): AsyncIterable<ExtStock>;
  /** Idempotent push support: an order we already sent is found by our order number. */
  findOrderByClientRef(ref: string): Promise<ExtOrderRef | null>;
  pushOrder(order: CanonicalOrder, idempotencyKey: string): Promise<ExtOrderRef>;
  readOrderStatus(externalId: string): Promise<ExtOrderStatus>;
}

/** Push with search-before-create, so a retry after a crash never creates a second order. */
export async function pushOrderIdempotent(connector: ErpConnector, order: CanonicalOrder, idempotencyKey: string): Promise<{ ref: ExtOrderRef; created: boolean }> {
  const existing = await connector.findOrderByClientRef(order.orderNumber);
  if (existing) return { ref: existing, created: false };
  const ref = await connector.pushOrder(order, idempotencyKey);
  return { ref, created: true };
}
