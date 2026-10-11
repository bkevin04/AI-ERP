import type {
  Address,
  AgentPolicy,
  AutonomyLevel,
  DocumentKind,
  EventType,
  PrincipalKind,
  ProductAlias,
  ProposalStatus,
  RunStatus,
  StepKind,
} from "@ai-erp/contracts";

/**
 * The repository contract the core logic runs against.
 *
 * Postgres implements it in `@ai-erp/db` (every query runs under row-level security
 * inside a transaction that has `SET LOCAL app.tenant_id`). Tests use the in-memory
 * implementation in `./testing`. Core never touches SQL directly.
 */

export interface TenantInfo {
  id: string;
  slug: string;
  autonomyLevel: AutonomyLevel;
  agentsPausedAt: Date | null;
  settings: Record<string, unknown>;
}

export interface PrincipalContext {
  id: string;
  tenantId: string;
  kind: PrincipalKind;
  displayName: string;
  scopes: ReadonlySet<string>;
  /** Present for agent principals; null for humans and services. */
  policy: AgentPolicy | null;
}

export interface CustomerSummary {
  id: string;
  name: string;
  normalizedName: string;
  emailDomains: string[];
  billingPostalCode: string | null;
  shipTo: Address[];
  defaultPriceListId: string | null;
  status: "active" | "inactive";
}

export interface ProductSummary {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  baseUom: string;
  barcode: string | null;
  packFactors: Record<string, number>;
  listPrice: number | null;
  status: "active" | "inactive";
}

export interface PriceResolution {
  unitPrice: number;
  priceListId: string | null;
  source: "customer_list" | "tenant_default" | "list_price";
}

export interface NewRunStep {
  id: string;
  runId: string;
  seq: number;
  kind: StepKind;
  name: string;
  input: unknown;
  output: unknown;
  idempotencyKey: string;
  status: "ok" | "error";
  durationMs: number;
}

export interface StoredRunStep {
  id: string;
  seq: number;
  name: string;
  output: unknown;
  status: "ok" | "error";
}

export interface NewProvenanceEntry {
  id: string;
  entityType: string;
  entityId: string;
  entityVersion: number | null;
  action: string;
  runId: string | null;
  stepId: string | null;
  proposalId: string | null;
  approvalId: string | null;
  policyVersion: string | null;
  promptVersion: string | null;
  modelId: string | null;
  sourceDocumentIds: string[];
  actorPrincipalId: string;
  diff: unknown;
}

export interface NewProposal {
  id: string;
  runId: string | null;
  kind: "create_order";
  payload: unknown;
  payloadSchemaVersion: number;
  confidence: number;
  confidenceBreakdown: unknown;
  flags: string[];
  explanation: string;
  policyResult: unknown;
  status: ProposalStatus;
  supersedesId: string | null;
}

export interface NewDocument {
  id: string;
  kind: DocumentKind;
  storageKey: string;
  sha256: string;
  mime: string;
  filename: string | null;
  parentDocumentId: string | null;
  fromAddress: string | null;
  providerMessageId: string | null;
  textKey: string | null;
  pageCount: number | null;
}

export interface NewEvent {
  id: string;
  type: EventType;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}

export interface NewAgentRun {
  id: string;
  principalId: string;
  triggerEventId: string | null;
  workflow: string;
  status: RunStatus;
}

export interface CoreStore {
  /** Runs `fn` inside a tenant-scoped transaction. Nested calls reuse the outer transaction. */
  transaction<T>(tenantId: string, fn: (tx: CoreStore) => Promise<T>): Promise<T>;

  // identity
  getTenant(tenantId: string): Promise<TenantInfo | null>;
  getPrincipal(principalId: string): Promise<PrincipalContext | null>;
  resolvePrincipalByApiKeyHash(keyHash: string): Promise<PrincipalContext | null>;

  // tool invocations, idempotency, ledger
  recordInvocation(rec: { id: string; principalId: string; tool: string; at: Date }): Promise<void>;
  countInvocationsSince(principalId: string, since: Date): Promise<number>;
  getIdempotentResult(
    principalId: string,
    tool: string,
    key: string,
  ): Promise<{ requestHash: string; result: unknown } | null>;
  saveIdempotentResult(rec: {
    principalId: string;
    tool: string;
    key: string;
    requestHash: string;
    result: unknown;
  }): Promise<void>;
  findRunStep(runId: string, idempotencyKey: string): Promise<StoredRunStep | null>;
  insertRunStep(step: NewRunStep): Promise<void>;
  insertProvenance(entries: NewProvenanceEntry[]): Promise<void>;

  // runs
  insertAgentRun(run: NewAgentRun): Promise<void>;
  updateAgentRunStatus(runId: string, status: RunStatus, error?: string | null): Promise<void>;

  // master data queries used by matching
  findCustomersByContactEmail(email: string): Promise<CustomerSummary[]>;
  findCustomersByDomain(domain: string): Promise<CustomerSummary[]>;
  searchCustomersByName(
    name: string,
    limit: number,
  ): Promise<Array<{ customer: CustomerSummary; similarity: number }>>;
  findCustomersByPoPrefix(prefix: string): Promise<CustomerSummary[]>;
  getCustomer(customerId: string): Promise<CustomerSummary | null>;
  findProductAliases(
    aliasNorm: string,
    customerId: string | null,
  ): Promise<Array<{ alias: Pick<ProductAlias, "aliasType" | "customerId" | "uomOverride">; product: ProductSummary }>>;
  findProductBySku(skuNorm: string): Promise<ProductSummary | null>;
  findProductByBarcode(barcode: string): Promise<ProductSummary | null>;
  searchProducts(text: string, limit: number): Promise<Array<{ product: ProductSummary; score: number }>>;
  getProduct(productId: string): Promise<ProductSummary | null>;
  resolvePrice(customerId: string | null, productId: string, qty: number): Promise<PriceResolution | null>;
  getStock(productId: string): Promise<{ qtyAvailable: number } | null>;
  findOrderByCustomerPo(customerId: string, poNumber: string): Promise<{ id: string; number: string } | null>;

  // proposals, documents, events, gates
  insertProposal(p: NewProposal): Promise<void>;
  insertDocument(d: NewDocument): Promise<{ id: string; created: boolean }>;
  insertEvent(e: NewEvent): Promise<{ id: string; created: boolean }>;
  isAutonomyGateGreen(tenantId: string): Promise<boolean>;
}
