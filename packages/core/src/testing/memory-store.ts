import type { AgentPolicy, Address, EventType, PrincipalKind, ProposalStatus, RunStatus } from "@ai-erp/contracts";
import type {
  CoreStore, CustomerSummary, NewAgentRun, NewDocument, NewEvent, NewProposal, NewProvenanceEntry, NewRunStep,
  PriceResolution, PrincipalContext, ProductSummary, StoredRunStep, TenantInfo,
} from "../store.js";
import { newId, normalizeSku, normalizeText, trigramSimilarity } from "../util.js";

/**
 * In-memory implementation of CoreStore for tests and local experiments.
 * One MemoryDb holds every tenant; a store instance is scoped to one tenant,
 * mirroring how RLS scopes the Postgres implementation.
 */
export class MemoryDb {
  tenants = new Map<string, TenantInfo>();
  principals = new Map<string, PrincipalContext>();
  apiKeys = new Map<string, string>(); // keyHash -> principalId
  customers: Array<CustomerSummary & { tenantId: string }> = [];
  contacts: Array<{ tenantId: string; customerId: string; email: string }> = [];
  products: Array<ProductSummary & { tenantId: string }> = [];
  aliases: Array<{ tenantId: string; productId: string; customerId: string | null; aliasType: "customer_part_no" | "description" | "synonym"; aliasNorm: string; uomOverride: string | null }> = [];
  prices: Array<{ tenantId: string; priceListId: string; productId: string; minQty: number; unitPrice: number }> = [];
  customerPriceLists: Array<{ tenantId: string; customerId: string; priceListId: string; priority: number }> = [];
  defaultPriceLists = new Map<string, string>(); // tenantId -> priceListId
  stock: Array<{ tenantId: string; productId: string; qtyAvailable: number }> = [];
  orders: Array<{ tenantId: string; id: string; number: string; customerId: string; customerPoNumber: string | null }> = [];
  invocations: Array<{ tenantId: string; id: string; principalId: string; tool: string; at: Date }> = [];
  idempotency = new Map<string, { requestHash: string; result: unknown }>();
  runSteps: Array<NewRunStep & { tenantId: string }> = [];
  provenance: Array<NewProvenanceEntry & { tenantId: string }> = [];
  runs: Array<NewAgentRun & { tenantId: string; error: string | null }> = [];
  proposals: Array<NewProposal & { tenantId: string }> = [];
  documents: Array<NewDocument & { tenantId: string }> = [];
  events: Array<NewEvent & { tenantId: string; occurredAt: Date }> = [];
  gates = new Map<string, boolean>();

  forTenant(tenantId: string): InMemoryCoreStore {
    return new InMemoryCoreStore(this, tenantId);
  }

  // ---- fixture helpers ------------------------------------------------------
  addTenant(t: Partial<TenantInfo> & { id?: string } = {}): TenantInfo {
    const tenant: TenantInfo = {
      id: t.id ?? newId(), slug: t.slug ?? "acme", autonomyLevel: t.autonomyLevel ?? 1,
      agentsPausedAt: t.agentsPausedAt ?? null, settings: t.settings ?? {},
    };
    this.tenants.set(tenant.id, tenant);
    return tenant;
  }

  addPrincipal(p: { tenantId: string; kind: PrincipalKind; scopes: string[]; policy?: Partial<AgentPolicy> | null; id?: string; displayName?: string; apiKeyHash?: string }): PrincipalContext {
    const id = p.id ?? newId();
    const policy: AgentPolicy | null =
      p.kind === "agent"
        ? { principalId: id, allowedTools: null, autoCommitEnabled: false, maxAutoOrderValue: null, rateLimitPerHour: null, killedAt: null, ...(p.policy ?? {}) }
        : null;
    const principal: PrincipalContext = { id, tenantId: p.tenantId, kind: p.kind, displayName: p.displayName ?? p.kind, scopes: new Set(p.scopes), policy };
    this.principals.set(id, principal);
    if (p.apiKeyHash) this.apiKeys.set(p.apiKeyHash, id);
    return principal;
  }

  addCustomer(c: { tenantId: string; name: string; id?: string; emailDomains?: string[]; contacts?: string[]; billingPostalCode?: string | null; shipTo?: Address[]; status?: "active" | "inactive"; defaultPriceListId?: string | null }): CustomerSummary {
    const cust: CustomerSummary & { tenantId: string } = {
      tenantId: c.tenantId, id: c.id ?? newId(), name: c.name, normalizedName: normalizeText(c.name),
      emailDomains: (c.emailDomains ?? []).map((d) => d.toLowerCase()), billingPostalCode: c.billingPostalCode ?? null,
      shipTo: c.shipTo ?? [], defaultPriceListId: c.defaultPriceListId ?? null, status: c.status ?? "active",
    };
    this.customers.push(cust);
    for (const email of c.contacts ?? []) this.contacts.push({ tenantId: c.tenantId, customerId: cust.id, email: email.toLowerCase() });
    return cust;
  }

  addProduct(p: { tenantId: string; sku: string; name: string; id?: string; description?: string | null; baseUom?: string; barcode?: string | null; packFactors?: Record<string, number>; listPrice?: number | null; status?: "active" | "inactive"; qtyAvailable?: number }): ProductSummary {
    const prod: ProductSummary & { tenantId: string } = {
      tenantId: p.tenantId, id: p.id ?? newId(), sku: p.sku, name: p.name, description: p.description ?? null,
      baseUom: p.baseUom ?? "EA", barcode: p.barcode ?? null, packFactors: p.packFactors ?? {}, listPrice: p.listPrice ?? null, status: p.status ?? "active",
    };
    this.products.push(prod);
    if (p.qtyAvailable !== undefined) this.stock.push({ tenantId: p.tenantId, productId: prod.id, qtyAvailable: p.qtyAvailable });
    return prod;
  }

  addAlias(a: { tenantId: string; productId: string; alias: string; customerId?: string | null; aliasType?: "customer_part_no" | "description" | "synonym"; uomOverride?: string | null }): void {
    this.aliases.push({ tenantId: a.tenantId, productId: a.productId, customerId: a.customerId ?? null, aliasType: a.aliasType ?? "customer_part_no", aliasNorm: normalizeText(a.alias), uomOverride: a.uomOverride ?? null });
  }

  addPrice(p: { tenantId: string; priceListId: string; productId: string; unitPrice: number; minQty?: number }): void {
    this.prices.push({ tenantId: p.tenantId, priceListId: p.priceListId, productId: p.productId, minQty: p.minQty ?? 0, unitPrice: p.unitPrice });
  }
}

export class InMemoryCoreStore implements CoreStore {
  constructor(readonly db: MemoryDb, readonly tenantId: string) {}

  private mine<T extends { tenantId: string }>(rows: T[]): T[] {
    return rows.filter((r) => r.tenantId === this.tenantId);
  }

  async transaction<T>(tenantId: string, fn: (tx: CoreStore) => Promise<T>): Promise<T> {
    return fn(tenantId === this.tenantId ? this : new InMemoryCoreStore(this.db, tenantId));
  }

  async getTenant(tenantId: string): Promise<TenantInfo | null> {
    return this.db.tenants.get(tenantId) ?? null;
  }
  async getPrincipal(principalId: string): Promise<PrincipalContext | null> {
    const p = this.db.principals.get(principalId);
    return p && p.tenantId === this.tenantId ? p : null;
  }
  async resolvePrincipalByApiKeyHash(keyHash: string): Promise<PrincipalContext | null> {
    const id = this.db.apiKeys.get(keyHash);
    return id ? (this.db.principals.get(id) ?? null) : null;
  }

  async recordInvocation(rec: { id: string; principalId: string; tool: string; at: Date }): Promise<void> {
    this.db.invocations.push({ tenantId: this.tenantId, ...rec });
  }
  async countInvocationsSince(principalId: string, since: Date): Promise<number> {
    return this.mine(this.db.invocations).filter((i) => i.principalId === principalId && i.at >= since).length;
  }
  async getIdempotentResult(principalId: string, tool: string, key: string) {
    return this.db.idempotency.get(`${this.tenantId}|${principalId}|${tool}|${key}`) ?? null;
  }
  async saveIdempotentResult(rec: { principalId: string; tool: string; key: string; requestHash: string; result: unknown }): Promise<void> {
    this.db.idempotency.set(`${this.tenantId}|${rec.principalId}|${rec.tool}|${rec.key}`, { requestHash: rec.requestHash, result: rec.result });
  }
  async findRunStep(runId: string, idempotencyKey: string): Promise<StoredRunStep | null> {
    const s = this.mine(this.db.runSteps).find((r) => r.runId === runId && r.idempotencyKey === idempotencyKey);
    return s ? { id: s.id, seq: s.seq, name: s.name, output: s.output, status: s.status } : null;
  }
  async insertRunStep(step: NewRunStep): Promise<void> {
    this.db.runSteps.push({ tenantId: this.tenantId, ...step });
  }
  async insertProvenance(entries: NewProvenanceEntry[]): Promise<void> {
    for (const e of entries) this.db.provenance.push({ tenantId: this.tenantId, ...e });
  }
  async insertAgentRun(run: NewAgentRun): Promise<void> {
    this.db.runs.push({ tenantId: this.tenantId, error: null, ...run });
  }
  async updateAgentRunStatus(runId: string, status: RunStatus, error?: string | null): Promise<void> {
    const r = this.mine(this.db.runs).find((x) => x.id === runId);
    if (r) { r.status = status; r.error = error ?? null; }
  }

  async findCustomersByContactEmail(email: string): Promise<CustomerSummary[]> {
    const ids = new Set(this.mine(this.db.contacts).filter((c) => c.email === email.toLowerCase()).map((c) => c.customerId));
    return this.mine(this.db.customers).filter((c) => ids.has(c.id));
  }
  async findCustomersByDomain(domain: string): Promise<CustomerSummary[]> {
    return this.mine(this.db.customers).filter((c) => c.emailDomains.includes(domain.toLowerCase()));
  }
  async searchCustomersByName(name: string, limit: number) {
    return this.mine(this.db.customers)
      .map((customer) => ({ customer, similarity: trigramSimilarity(name, customer.name) }))
      .filter((h) => h.similarity > 0.2)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }
  async findCustomersByPoPrefix(prefix: string): Promise<CustomerSummary[]> {
    const ids = new Set(this.mine(this.db.orders).filter((o) => o.customerPoNumber?.startsWith(prefix)).map((o) => o.customerId));
    return this.mine(this.db.customers).filter((c) => ids.has(c.id));
  }
  async getCustomer(customerId: string): Promise<CustomerSummary | null> {
    return this.mine(this.db.customers).find((c) => c.id === customerId) ?? null;
  }
  async findProductAliases(aliasNorm: string, customerId: string | null) {
    return this.mine(this.db.aliases)
      .filter((a) => a.aliasNorm === aliasNorm && (a.customerId === null || a.customerId === customerId))
      .map((alias) => ({ alias: { aliasType: alias.aliasType, customerId: alias.customerId, uomOverride: alias.uomOverride }, product: this.mine(this.db.products).find((p) => p.id === alias.productId)! }))
      .filter((h) => !!h.product);
  }
  async findProductBySku(skuNorm: string): Promise<ProductSummary | null> {
    return this.mine(this.db.products).find((p) => normalizeSku(p.sku) === skuNorm) ?? null;
  }
  async findProductByBarcode(barcode: string): Promise<ProductSummary | null> {
    return this.mine(this.db.products).find((p) => p.barcode === barcode) ?? null;
  }
  async searchProducts(text: string, limit: number) {
    return this.mine(this.db.products)
      .map((product) => ({ product, score: Math.max(trigramSimilarity(text, product.name), trigramSimilarity(text, `${product.sku} ${product.description ?? ""}`)) }))
      .filter((h) => h.score > 0.15)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
  async getProduct(productId: string): Promise<ProductSummary | null> {
    return this.mine(this.db.products).find((p) => p.id === productId) ?? null;
  }
  async resolvePrice(customerId: string | null, productId: string, qty: number): Promise<PriceResolution | null> {
    const pick = (priceListId: string): number | null => {
      const rows = this.mine(this.db.prices).filter((p) => p.priceListId === priceListId && p.productId === productId && p.minQty <= qty).sort((a, b) => b.minQty - a.minQty);
      return rows[0]?.unitPrice ?? null;
    };
    if (customerId) {
      const lists = this.mine(this.db.customerPriceLists).filter((l) => l.customerId === customerId).sort((a, b) => a.priority - b.priority);
      const cust = await this.getCustomer(customerId);
      if (cust?.defaultPriceListId) lists.unshift({ tenantId: this.tenantId, customerId, priceListId: cust.defaultPriceListId, priority: -1 });
      for (const l of lists) { const price = pick(l.priceListId); if (price !== null) return { unitPrice: price, priceListId: l.priceListId, source: "customer_list" }; }
    }
    const def = this.db.defaultPriceLists.get(this.tenantId);
    if (def) { const price = pick(def); if (price !== null) return { unitPrice: price, priceListId: def, source: "tenant_default" }; }
    const product = await this.getProduct(productId);
    if (product?.listPrice != null) return { unitPrice: product.listPrice, priceListId: null, source: "list_price" };
    return null;
  }
  async getStock(productId: string) {
    const s = this.mine(this.db.stock).find((x) => x.productId === productId);
    return s ? { qtyAvailable: s.qtyAvailable } : null;
  }
  async findOrderByCustomerPo(customerId: string, poNumber: string) {
    const o = this.mine(this.db.orders).find((x) => x.customerId === customerId && x.customerPoNumber === poNumber);
    return o ? { id: o.id, number: o.number } : null;
  }

  async insertProposal(p: NewProposal): Promise<void> {
    this.db.proposals.push({ tenantId: this.tenantId, ...p });
  }
  async insertDocument(d: NewDocument): Promise<{ id: string; created: boolean }> {
    const existing = this.mine(this.db.documents).find((x) => x.sha256 === d.sha256);
    if (existing) return { id: existing.id, created: false };
    this.db.documents.push({ tenantId: this.tenantId, ...d });
    return { id: d.id, created: true };
  }
  async insertEvent(e: NewEvent): Promise<{ id: string; created: boolean }> {
    const existing = this.mine(this.db.events).find((x) => x.idempotencyKey === e.idempotencyKey);
    if (existing) return { id: existing.id, created: false };
    this.db.events.push({ tenantId: this.tenantId, occurredAt: new Date(), ...e });
    return { id: e.id, created: true };
  }
  async isAutonomyGateGreen(tenantId: string): Promise<boolean> {
    return this.db.gates.get(tenantId) ?? false;
  }

  async listProposals(statuses: string[], limit = 50) {
    return this.mine(this.db.proposals).filter((p) => statuses.includes(p.status)).slice(-limit).reverse();
  }

  async resolveInboundMailbox(slug: string): Promise<{ tenantId: string; principalId: string } | null> {
    const tenant = [...this.db.tenants.values()].find((t) => t.slug === slug);
    if (!tenant) return null;
    const principal = [...this.db.principals.values()].find((p) => p.tenantId === tenant.id && p.kind === "service" && p.displayName === "inbound-email");
    return principal ? { tenantId: tenant.id, principalId: principal.id } : null;
  }
}

export type { ProposalStatus, EventType };
