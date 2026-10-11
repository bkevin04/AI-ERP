import { z } from "zod";
import { OdooConnector } from "@ai-erp/connector-odoo";
import { DryRunConnector, syncMasterData, type ErpConnector, type MasterDataSink } from "@ai-erp/connector-sdk";
import type { ExtCustomer, ExtPriceList, ExtProduct, ExtStock } from "@ai-erp/contracts";
import { normalizeSku, normalizeText } from "@ai-erp/core";
import { schema, type Db, type PgCoreStore } from "@ai-erp/db";
import { and, eq, sql } from "drizzle-orm";

export const SyncJob = z.object({ tenantId: z.uuid(), connectorId: z.uuid() });

/** Postgres sink: upserts core tables and keeps connector_mappings with a content hash. */
export class PgMasterDataSink implements MasterDataSink {
  constructor(private readonly db: Db, private readonly tenantId: string, private readonly connectorId: string) {}

  private async mapping(entityType: string, externalId: string) {
    const rows = await this.db.select().from(schema.connectorMappings).where(and(eq(schema.connectorMappings.connectorId, this.connectorId), eq(schema.connectorMappings.entityType, entityType), eq(schema.connectorMappings.externalId, externalId))).limit(1);
    return rows[0] ?? null;
  }
  private async saveMapping(entityType: string, externalId: string, internalId: string, hash: string) {
    await this.db.insert(schema.connectorMappings).values({ tenantId: this.tenantId, connectorId: this.connectorId, entityType, internalId, externalId, syncHash: hash, lastSyncedAt: new Date() })
      .onConflictDoUpdate({ target: [schema.connectorMappings.connectorId, schema.connectorMappings.entityType, schema.connectorMappings.externalId], set: { syncHash: hash, lastSyncedAt: new Date(), internalId } });
  }
  private async internalProductId(externalId: string): Promise<string | null> {
    return (await this.mapping("product", externalId))?.internalId ?? null;
  }

  async upsertCustomer(ext: ExtCustomer, hash: string) {
    const m = await this.mapping("customer", ext.externalId);
    if (m?.syncHash === hash) return "unchanged" as const;
    const values = { tenantId: this.tenantId, name: ext.name, normalizedName: normalizeText(ext.name), emailDomains: ext.emailDomains, billingAddress: ext.billingAddress as Record<string, unknown> | null, shipTo: ext.shipTo, paymentTerms: ext.paymentTerms, status: ext.active ? ("active" as const) : ("inactive" as const), updatedAt: new Date() };
    let id = m?.internalId ?? null;
    if (id) await this.db.update(schema.customers).set(values).where(eq(schema.customers.id, id));
    else id = (await this.db.insert(schema.customers).values(values).returning({ id: schema.customers.id }))[0]!.id;
    await this.db.delete(schema.customerContacts).where(eq(schema.customerContacts.customerId, id));
    const contacts = ext.contacts.filter((c) => c.email).map((c) => ({ tenantId: this.tenantId, customerId: id!, email: c.email!.toLowerCase(), name: c.name }));
    if (ext.email) contacts.push({ tenantId: this.tenantId, customerId: id, email: ext.email.toLowerCase(), name: null });
    if (contacts.length) await this.db.insert(schema.customerContacts).values(contacts).onConflictDoNothing();
    await this.saveMapping("customer", ext.externalId, id, hash);
    return m ? ("updated" as const) : ("created" as const);
  }

  async upsertProduct(ext: ExtProduct, hash: string) {
    const m = await this.mapping("product", ext.externalId);
    if (m?.syncHash === hash) return "unchanged" as const;
    const values = { tenantId: this.tenantId, sku: ext.sku, skuNorm: normalizeSku(ext.sku), name: ext.name, description: ext.description, baseUom: ext.uom, barcode: ext.barcode, listPrice: ext.listPrice, status: ext.active ? ("active" as const) : ("inactive" as const), updatedAt: new Date() };
    let id = m?.internalId ?? null;
    if (id) await this.db.update(schema.products).set(values).where(eq(schema.products.id, id));
    else id = (await this.db.insert(schema.products).values(values).onConflictDoUpdate({ target: [schema.products.tenantId, schema.products.skuNorm], set: values }).returning({ id: schema.products.id }))[0]!.id;
    await this.saveMapping("product", ext.externalId, id, hash);
    return m ? ("updated" as const) : ("created" as const);
  }

  async upsertPriceList(ext: ExtPriceList, hash: string) {
    const m = await this.mapping("price_list", ext.externalId);
    if (m?.syncHash === hash) return "unchanged" as const;
    let id = m?.internalId ?? null;
    const values = { tenantId: this.tenantId, name: ext.name, currency: ext.currency.slice(0, 3) };
    if (id) await this.db.update(schema.priceLists).set(values).where(eq(schema.priceLists.id, id));
    else id = (await this.db.insert(schema.priceLists).values(values).returning({ id: schema.priceLists.id }))[0]!.id;
    await this.db.delete(schema.priceListItems).where(eq(schema.priceListItems.priceListId, id));
    for (const item of ext.items) {
      const productId = await this.internalProductId(item.productExternalId);
      if (!productId) continue;
      await this.db.insert(schema.priceListItems).values({ tenantId: this.tenantId, priceListId: id, productId, minQty: item.minQty, unitPrice: item.unitPrice, uom: item.uom }).onConflictDoNothing();
    }
    await this.saveMapping("price_list", ext.externalId, id, hash);
    return m ? ("updated" as const) : ("created" as const);
  }

  async upsertStock(ext: ExtStock) {
    const productId = await this.internalProductId(ext.productExternalId);
    if (!productId) return;
    await this.db.insert(schema.stockSnapshots).values({ tenantId: this.tenantId, productId, location: ext.location, qtyAvailable: ext.qtyAvailable, asOf: ext.asOf })
      .onConflictDoUpdate({ target: [schema.stockSnapshots.productId, schema.stockSnapshots.location], set: { qtyAvailable: ext.qtyAvailable, asOf: ext.asOf } });
  }
}

export function connectorFromConfig(kind: string, config: Record<string, unknown>): ErpConnector {
  if (kind === "odoo") {
    return new OdooConnector({ url: String(config["url"] ?? process.env["ODOO_URL"] ?? "http://localhost:8069"), db: String(config["db"] ?? process.env["ODOO_DB"] ?? "odoo"), username: String(config["username"] ?? process.env["ODOO_USER"] ?? "admin"), apiKey: String(config["apiKey"] ?? process.env["ODOO_API_KEY"] ?? "admin") });
  }
  return new DryRunConnector();
}

export async function handleSyncJob(deps: { db: Db; root: PgCoreStore }, raw: unknown) {
  const job = SyncJob.parse(raw);
  const store = deps.root.forTenant(job.tenantId);
  return store.transaction(job.tenantId, async () => {
    const rows = await deps.db.select().from(schema.connectors).where(eq(schema.connectors.id, job.connectorId)).limit(1);
    const connector = rows[0];
    if (!connector) throw new Error(`connector ${job.connectorId} not found`);
    const report = await syncMasterData(connectorFromConfig(connector.kind, connector.config), new PgMasterDataSink(deps.db, job.tenantId, job.connectorId));
    await deps.db.execute(sql`SELECT 1`);
    console.log(`[sync] ${connector.kind} ${JSON.stringify(report)}`);
    return report;
  });
}
