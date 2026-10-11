import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type {
  CoreStore, CustomerSummary, NewAgentRun, NewDocument, NewEvent, NewProposal, NewProvenanceEntry, NewRunStep,
  PriceResolution, PrincipalContext, ProductSummary, StoredRunStep, TenantInfo,
} from "@ai-erp/core";
import { normalizeText } from "@ai-erp/core";
import type { RunStatus } from "@ai-erp/contracts";
import type { Db } from "./client.js";
import * as s from "./schema.js";

export interface PgStoreOptions {
  /** `SET LOCAL ROLE` to this role inside every transaction (tests run as superuser and assume app_user). */
  assumeRole?: string;
}

/**
 * Postgres implementation of CoreStore. Every query runs inside a transaction that has
 * `app.tenant_id` set, so row-level security does the tenant filtering; the code here
 * never adds `WHERE tenant_id = ...` by hand except for inserts, which must supply it.
 */
export class PgCoreStore implements CoreStore {
  constructor(
    private readonly db: Db,
    readonly tenantId: string | null,
    private readonly opts: PgStoreOptions = {},
    private readonly inTx = false,
  ) {}

  forTenant(tenantId: string): PgCoreStore {
    return new PgCoreStore(this.db, tenantId, this.opts, false);
  }

  private tid(): string {
    if (!this.tenantId) throw new Error("store is not tenant-scoped");
    return this.tenantId;
  }

  async transaction<T>(tenantId: string, fn: (tx: CoreStore) => Promise<T>): Promise<T> {
    if (this.inTx) {
      if (tenantId !== this.tenantId) throw new Error("cannot switch tenant inside a transaction");
      return fn(this);
    }
    return this.db.transaction(async (tx) => {
      if (this.opts.assumeRole) await tx.execute(sql.raw(`SET LOCAL ROLE "${this.opts.assumeRole.replace(/"/g, '""')}"`));
      await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
      return fn(new PgCoreStore(tx as unknown as Db, tenantId, this.opts, true));
    });
  }

  /** Run `fn` with a tenant-scoped db handle, opening a transaction when not already in one. */
  private q<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    if (this.inTx) return fn(this.db);
    return this.transaction(this.tid(), (tx) => fn((tx as PgCoreStore).db));
  }

  /**
   * Run `fn` with this tenant's RLS-scoped db handle, for queries the CoreStore contract does not
   * cover. Use this instead of a pooled `Db`: outside the tenant transaction, `app.tenant_id` is
   * unset and row-level security hides every row.
   */
  withTenantDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    return this.q(fn);
  }

  // ---- identity ---------------------------------------------------------------
  /** Runs in the caller's tenant context: a tenant-scoped store can only ever see its own row. */
  async getTenant(tenantId: string): Promise<TenantInfo | null> {
    const scoped = this.tenantId ? this : new PgCoreStore(this.db, tenantId, this.opts, false);
    const rows = await scoped.q((db) => db.select().from(s.tenants).where(eq(s.tenants.id, tenantId)).limit(1));
    const t = rows[0];
    return t ? { id: t.id, slug: t.slug, autonomyLevel: t.autonomyLevel as 0 | 1 | 2, agentsPausedAt: t.agentsPausedAt, settings: t.settings } : null;
  }

  async getPrincipal(principalId: string): Promise<PrincipalContext | null> {
    return this.q(async (db) => {
      const rows = await db.select().from(s.principals).where(eq(s.principals.id, principalId)).limit(1);
      const p = rows[0];
      if (!p || p.status !== "active") return null;
      const scopeRows = await db
        .select({ scope: s.roleScopes.scope })
        .from(s.principalRoles)
        .innerJoin(s.roleScopes, eq(s.roleScopes.roleId, s.principalRoles.roleId))
        .where(eq(s.principalRoles.principalId, principalId));
      const policyRows = await db.select().from(s.agentPolicies).where(eq(s.agentPolicies.principalId, principalId)).limit(1);
      const pol = policyRows[0];
      return {
        id: p.id, tenantId: p.tenantId, kind: p.kind, displayName: p.displayName,
        scopes: new Set(scopeRows.map((r) => r.scope)),
        policy: p.kind === "agent"
          ? { principalId: p.id, allowedTools: pol?.allowedTools ?? null, autoCommitEnabled: pol?.autoCommitEnabled ?? false, maxAutoOrderValue: pol?.maxAutoOrderValue ?? null, rateLimitPerHour: pol?.rateLimitPerHour ?? null, killedAt: pol?.killedAt ?? null }
          : null,
      };
    });
  }

  /** Runs outside any tenant context through a SECURITY DEFINER function. */
  async resolvePrincipalByApiKeyHash(keyHash: string): Promise<PrincipalContext | null> {
    const run = async (db: Db) => {
      if (this.opts.assumeRole && !this.inTx) {
        return db.transaction(async (tx) => {
          await tx.execute(sql.raw(`SET LOCAL ROLE "${this.opts.assumeRole!.replace(/"/g, '""')}"`));
          return tx.execute(sql`SELECT * FROM resolve_api_key(${keyHash})`);
        });
      }
      return db.execute(sql`SELECT * FROM resolve_api_key(${keyHash})`);
    };
    const res = await run(this.db);
    const row = (Array.isArray(res) ? res[0] : (res as { rows?: unknown[] }).rows?.[0]) as Record<string, unknown> | undefined;
    if (!row) return null;
    const kind = row["kind"] as PrincipalContext["kind"];
    const scopes = new Set<string>([...(row["key_scopes"] as string[] ?? []), ...(row["role_scopes"] as string[] ?? [])]);
    return {
      id: row["principal_id"] as string, tenantId: row["tenant_id"] as string, kind, displayName: row["display_name"] as string, scopes,
      policy: kind === "agent"
        ? { principalId: row["principal_id"] as string, allowedTools: (row["allowed_tools"] as string[] | null) ?? null, autoCommitEnabled: Boolean(row["auto_commit_enabled"]), maxAutoOrderValue: row["max_auto_order_value"] == null ? null : Number(row["max_auto_order_value"]), rateLimitPerHour: (row["rate_limit_per_hour"] as number | null) ?? null, killedAt: row["killed_at"] ? new Date(row["killed_at"] as string) : null }
        : null,
    };
  }

  // ---- invocations, idempotency, ledger ---------------------------------------
  async recordInvocation(rec: { id: string; principalId: string; tool: string; at: Date }): Promise<void> {
    await this.q((db) => db.insert(s.toolInvocations).values({ id: rec.id, tenantId: this.tid(), principalId: rec.principalId, tool: rec.tool, at: rec.at }));
  }
  async countInvocationsSince(principalId: string, since: Date): Promise<number> {
    const rows = await this.q((db) => db.select({ n: sql<number>`count(*)::int` }).from(s.toolInvocations).where(and(eq(s.toolInvocations.principalId, principalId), gte(s.toolInvocations.at, since))));
    return rows[0]?.n ?? 0;
  }
  async getIdempotentResult(principalId: string, tool: string, key: string) {
    const rows = await this.q((db) => db.select().from(s.idempotencyKeys).where(and(eq(s.idempotencyKeys.principalId, principalId), eq(s.idempotencyKeys.tool, tool), eq(s.idempotencyKeys.key, key))).limit(1));
    return rows[0] ? { requestHash: rows[0].requestHash, result: rows[0].result } : null;
  }
  async saveIdempotentResult(rec: { principalId: string; tool: string; key: string; requestHash: string; result: unknown }): Promise<void> {
    await this.q((db) => db.insert(s.idempotencyKeys).values({ tenantId: this.tid(), ...rec }).onConflictDoNothing());
  }
  async findRunStep(runId: string, idempotencyKey: string): Promise<StoredRunStep | null> {
    const rows = await this.q((db) => db.select().from(s.runSteps).where(and(eq(s.runSteps.runId, runId), eq(s.runSteps.idempotencyKey, idempotencyKey))).limit(1));
    const r = rows[0];
    return r ? { id: r.id, seq: r.seq, name: r.name, output: r.output, status: r.status } : null;
  }
  async insertRunStep(step: NewRunStep): Promise<void> {
    await this.q((db) => db.insert(s.runSteps).values({ tenantId: this.tid(), ...step }));
  }
  async insertProvenance(entries: NewProvenanceEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await this.q((db) => db.insert(s.provenanceEntries).values(entries.map((e) => ({ tenantId: this.tid(), ...e }))));
  }
  async insertAgentRun(run: NewAgentRun): Promise<void> {
    await this.q((db) => db.insert(s.agentRuns).values({ tenantId: this.tid(), ...run, startedAt: new Date() }));
  }
  async updateAgentRunStatus(runId: string, status: RunStatus, error?: string | null): Promise<void> {
    await this.q((db) => db.update(s.agentRuns).set({ status, error: error ?? null, finishedAt: new Date() }).where(eq(s.agentRuns.id, runId)));
  }

  // ---- master data ---------------------------------------------------------------
  private toCustomer(c: typeof s.customers.$inferSelect): CustomerSummary {
    const billing = (c.billingAddress ?? null) as { postalCode?: string } | null;
    return {
      id: c.id, name: c.name, normalizedName: c.normalizedName, emailDomains: c.emailDomains,
      billingPostalCode: billing?.postalCode ?? null, shipTo: c.shipTo as CustomerSummary["shipTo"],
      defaultPriceListId: c.defaultPriceListId, status: c.status,
    };
  }
  private toProduct(p: typeof s.products.$inferSelect): ProductSummary {
    return { id: p.id, sku: p.sku, name: p.name, description: p.description, baseUom: p.baseUom, barcode: p.barcode, packFactors: p.packFactors, listPrice: p.listPrice, status: p.status };
  }

  async findCustomersByContactEmail(email: string): Promise<CustomerSummary[]> {
    const rows = await this.q((db) => db.select({ c: s.customers }).from(s.customerContacts).innerJoin(s.customers, eq(s.customers.id, s.customerContacts.customerId)).where(sql`lower(${s.customerContacts.email}) = ${email.toLowerCase()}`));
    return rows.map((r) => this.toCustomer(r.c));
  }
  async findCustomersByDomain(domain: string): Promise<CustomerSummary[]> {
    const rows = await this.q((db) => db.select().from(s.customers).where(sql`${s.customers.emailDomains} @> ARRAY[${domain.toLowerCase()}]::text[]`));
    return rows.map((r) => this.toCustomer(r));
  }
  async searchCustomersByName(name: string, limit: number) {
    const q = normalizeText(name);
    const rows = await this.q((db) => db.select({ c: s.customers, sim: sql<number>`similarity(${s.customers.normalizedName}, ${q})` }).from(s.customers).where(sql`similarity(${s.customers.normalizedName}, ${q}) > 0.2`).orderBy(desc(sql`similarity(${s.customers.normalizedName}, ${q})`)).limit(limit));
    return rows.map((r) => ({ customer: this.toCustomer(r.c), similarity: Number(r.sim) }));
  }
  async findCustomersByPoPrefix(prefix: string): Promise<CustomerSummary[]> {
    const rows = await this.q((db) => db.selectDistinct({ c: s.customers }).from(s.orders).innerJoin(s.customers, eq(s.customers.id, s.orders.customerId)).where(sql`${s.orders.customerPoNumber} LIKE ${prefix.replace(/[%_]/g, "\\$&") + "%"}`));
    return rows.map((r) => this.toCustomer(r.c));
  }
  async getCustomer(customerId: string): Promise<CustomerSummary | null> {
    const rows = await this.q((db) => db.select().from(s.customers).where(eq(s.customers.id, customerId)).limit(1));
    return rows[0] ? this.toCustomer(rows[0]) : null;
  }
  async findProductAliases(aliasNorm: string, customerId: string | null) {
    const rows = await this.q((db) => db.select({ a: s.productAliases, p: s.products }).from(s.productAliases).innerJoin(s.products, eq(s.products.id, s.productAliases.productId)).where(and(eq(s.productAliases.aliasNorm, aliasNorm), customerId ? sql`(${s.productAliases.customerId} IS NULL OR ${s.productAliases.customerId} = ${customerId})` : sql`${s.productAliases.customerId} IS NULL`)));
    return rows.map((r) => ({ alias: { aliasType: r.a.aliasType, customerId: r.a.customerId, uomOverride: r.a.uomOverride }, product: this.toProduct(r.p) }));
  }
  async findProductBySku(skuNorm: string): Promise<ProductSummary | null> {
    const rows = await this.q((db) => db.select().from(s.products).where(eq(s.products.skuNorm, skuNorm)).limit(1));
    return rows[0] ? this.toProduct(rows[0]) : null;
  }
  async findProductByBarcode(barcode: string): Promise<ProductSummary | null> {
    const rows = await this.q((db) => db.select().from(s.products).where(eq(s.products.barcode, barcode)).limit(1));
    return rows[0] ? this.toProduct(rows[0]) : null;
  }
  async searchProducts(text: string, limit: number) {
    const q = normalizeText(text);
    const score = sql<number>`greatest(similarity(${s.products.name}, ${q}), similarity(coalesce(${s.products.description}, ''), ${q}), CASE WHEN ${s.products.sku} ILIKE ${"%" + q + "%"} THEN 0.6 ELSE 0 END, CASE WHEN search @@ plainto_tsquery('simple', ${q}) THEN 0.5 ELSE 0 END)`;
    const rows = await this.q((db) => db.select({ p: s.products, score }).from(s.products).where(sql`${score} > 0.15`).orderBy(desc(score)).limit(limit));
    return rows.map((r) => ({ product: this.toProduct(r.p), score: Number(r.score) }));
  }
  async getProduct(productId: string): Promise<ProductSummary | null> {
    const rows = await this.q((db) => db.select().from(s.products).where(eq(s.products.id, productId)).limit(1));
    return rows[0] ? this.toProduct(rows[0]) : null;
  }
  async resolvePrice(customerId: string | null, productId: string, qty: number): Promise<PriceResolution | null> {
    return this.q(async (db) => {
      const pick = async (priceListId: string): Promise<number | null> => {
        const rows = await db.select().from(s.priceListItems).where(and(eq(s.priceListItems.priceListId, priceListId), eq(s.priceListItems.productId, productId), sql`${s.priceListItems.minQty} <= ${qty}`)).orderBy(desc(s.priceListItems.minQty)).limit(1);
        return rows[0]?.unitPrice ?? null;
      };
      if (customerId) {
        const lists: string[] = [];
        const cust = await db.select({ d: s.customers.defaultPriceListId }).from(s.customers).where(eq(s.customers.id, customerId)).limit(1);
        if (cust[0]?.d) lists.push(cust[0].d);
        const cpl = await db.select().from(s.customerPriceLists).where(eq(s.customerPriceLists.customerId, customerId)).orderBy(s.customerPriceLists.priority);
        lists.push(...cpl.map((r) => r.priceListId));
        for (const id of lists) { const price = await pick(id); if (price !== null) return { unitPrice: price, priceListId: id, source: "customer_list" as const }; }
      }
      const def = await db.select({ id: s.priceLists.id }).from(s.priceLists).where(eq(s.priceLists.isDefault, true)).limit(1);
      if (def[0]) { const price = await pick(def[0].id); if (price !== null) return { unitPrice: price, priceListId: def[0].id, source: "tenant_default" as const }; }
      const prod = await db.select({ lp: s.products.listPrice }).from(s.products).where(eq(s.products.id, productId)).limit(1);
      if (prod[0]?.lp != null) return { unitPrice: prod[0].lp, priceListId: null, source: "list_price" as const };
      return null;
    });
  }
  async getStock(productId: string) {
    const rows = await this.q((db) => db.select({ q: sql<number>`coalesce(sum(${s.stockSnapshots.qtyAvailable}), 0)::float8`, n: sql<number>`count(*)::int` }).from(s.stockSnapshots).where(eq(s.stockSnapshots.productId, productId)));
    return rows[0] && rows[0].n > 0 ? { qtyAvailable: Number(rows[0].q) } : null;
  }
  async findOrderByCustomerPo(customerId: string, poNumber: string) {
    const rows = await this.q((db) => db.select({ id: s.orders.id, number: s.orders.number }).from(s.orders).where(and(eq(s.orders.customerId, customerId), eq(s.orders.customerPoNumber, poNumber))).limit(1));
    return rows[0] ?? null;
  }

  // ---- proposals, documents, events, gates ------------------------------------------
  async insertProposal(p: NewProposal): Promise<void> {
    await this.q((db) => db.insert(s.proposals).values({ tenantId: this.tid(), ...p }));
  }
  async insertDocument(d: NewDocument): Promise<{ id: string; created: boolean }> {
    return this.q(async (db) => {
      const inserted = await db.insert(s.documents).values({ tenantId: this.tid(), ...d }).onConflictDoNothing().returning({ id: s.documents.id });
      if (inserted[0]) return { id: inserted[0].id, created: true };
      const existing = await db.select({ id: s.documents.id }).from(s.documents).where(eq(s.documents.sha256, d.sha256)).limit(1);
      return { id: existing[0]!.id, created: false };
    });
  }
  async insertEvent(e: NewEvent): Promise<{ id: string; created: boolean }> {
    return this.q(async (db) => {
      const inserted = await db.insert(s.events).values({ tenantId: this.tid(), ...e }).onConflictDoNothing().returning({ id: s.events.id });
      if (inserted[0]) return { id: inserted[0].id, created: true };
      const existing = await db.select({ id: s.events.id }).from(s.events).where(eq(s.events.idempotencyKey, e.idempotencyKey)).limit(1);
      return { id: existing[0]!.id, created: false };
    });
  }
  async isAutonomyGateGreen(tenantId: string): Promise<boolean> {
    const rows = await this.q((db) => db.select({ green: s.autonomyGates.green }).from(s.autonomyGates).where(and(eq(s.autonomyGates.tenantId, tenantId), eq(s.autonomyGates.segment, "default"))).limit(1));
    return rows[0]?.green ?? false;
  }

  /** Inbound mailbox lookup (orders+<slug>@...) runs before a tenant context exists. */
  async resolveInboundMailbox(slug: string): Promise<{ tenantId: string; principalId: string } | null> {
    const run = async (db: Db) => {
      if (this.opts.assumeRole && !this.inTx) {
        return db.transaction(async (tx) => {
          await tx.execute(sql.raw(`SET LOCAL ROLE "${this.opts.assumeRole!.replace(/"/g, '""')}"`));
          return tx.execute(sql`SELECT * FROM resolve_inbound_mailbox(${slug})`);
        });
      }
      return db.execute(sql`SELECT * FROM resolve_inbound_mailbox(${slug})`);
    };
    const res = await run(this.db);
    const row = (Array.isArray(res) ? res[0] : (res as { rows?: unknown[] }).rows?.[0]) as { tenant_id: string; principal_id: string } | undefined;
    return row ? { tenantId: row.tenant_id, principalId: row.principal_id } : null;
  }

  /** Convenience for the API: pending proposals for the review queue. */
  async listProposals(statuses: string[], limit = 50) {
    return this.q((db) => db.select().from(s.proposals).where(inArray(s.proposals.status, statuses)).orderBy(desc(s.proposals.createdAt)).limit(limit));
  }
}
