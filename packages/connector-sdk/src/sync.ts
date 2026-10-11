import type { ExtCustomer, ExtPriceList, ExtProduct, ExtStock } from "@ai-erp/contracts";
import { hashJson } from "@ai-erp/core";
import type { ErpConnector } from "./connector.js";

/**
 * Where synced master data lands. Postgres implements this in `@ai-erp/db`; the in-memory
 * version below is for tests. Each upsert receives the content hash so unchanged records
 * are skipped without touching the row.
 */
export interface MasterDataSink {
  upsertCustomer(ext: ExtCustomer, hash: string): Promise<"created" | "updated" | "unchanged">;
  upsertProduct(ext: ExtProduct, hash: string): Promise<"created" | "updated" | "unchanged">;
  upsertPriceList(ext: ExtPriceList, hash: string): Promise<"created" | "updated" | "unchanged">;
  upsertStock(ext: ExtStock): Promise<void>;
}

export interface SyncReport {
  customers: Record<"created" | "updated" | "unchanged", number>;
  products: Record<"created" | "updated" | "unchanged", number>;
  priceLists: Record<"created" | "updated" | "unchanged", number>;
  stock: number;
  errors: string[];
}

const counter = () => ({ created: 0, updated: 0, unchanged: 0 });

export async function syncMasterData(connector: ErpConnector, sink: MasterDataSink): Promise<SyncReport> {
  const report: SyncReport = { customers: counter(), products: counter(), priceLists: counter(), stock: 0, errors: [] };
  const guard = async (label: string, fn: () => Promise<void>) => {
    try { await fn(); } catch (err) { report.errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`); }
  };
  await guard("customers", async () => { for await (const c of connector.pullCustomers()) report.customers[await sink.upsertCustomer(c, hashJson(c))]++; });
  await guard("products", async () => { for await (const p of connector.pullProducts()) report.products[await sink.upsertProduct(p, hashJson(p))]++; });
  await guard("priceLists", async () => { for await (const l of connector.pullPriceLists()) report.priceLists[await sink.upsertPriceList(l, hashJson(l))]++; });
  await guard("stock", async () => { for await (const s of connector.pullStock()) { await sink.upsertStock(s); report.stock++; } });
  return report;
}

export class InMemoryMasterDataSink implements MasterDataSink {
  customers = new Map<string, { ext: ExtCustomer; hash: string }>();
  products = new Map<string, { ext: ExtProduct; hash: string }>();
  priceLists = new Map<string, { ext: ExtPriceList; hash: string }>();
  stock = new Map<string, ExtStock>();

  private up<T>(map: Map<string, { ext: T; hash: string }>, key: string, ext: T, hash: string) {
    const prev = map.get(key);
    if (prev && prev.hash === hash) return "unchanged" as const;
    map.set(key, { ext, hash });
    return prev ? ("updated" as const) : ("created" as const);
  }
  async upsertCustomer(ext: ExtCustomer, hash: string) { return this.up(this.customers, ext.externalId, ext, hash); }
  async upsertProduct(ext: ExtProduct, hash: string) { return this.up(this.products, ext.externalId, ext, hash); }
  async upsertPriceList(ext: ExtPriceList, hash: string) { return this.up(this.priceLists, ext.externalId, ext, hash); }
  async upsertStock(ext: ExtStock) { this.stock.set(`${ext.productExternalId}|${ext.location}`, ext); }
}
