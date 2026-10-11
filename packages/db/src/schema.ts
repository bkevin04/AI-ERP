import { sql } from "drizzle-orm";
import {
  boolean, char, date, index, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";

const money = (name: string) => numeric(name, { precision: 14, scale: 4, mode: "number" });

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  autonomyLevel: integer("autonomy_level").notNull().default(1),
  agentsPausedAt: timestamp("agents_paused_at", { withTimezone: true }),
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const principals = pgTable("principals", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  kind: text("kind", { enum: ["human", "agent", "service"] }).notNull(),
  displayName: text("display_name").notNull(),
  email: text("email"),
  status: text("status", { enum: ["active", "disabled"] }).notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const apiKeys = pgTable("api_keys", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  principalId: uuid("principal_id").notNull().references(() => principals.id),
  keyHash: text("key_hash").notNull().unique(),
  scopes: text("scopes").array().notNull().default([]),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const roles = pgTable("roles", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  name: text("name").notNull(),
});

export const roleScopes = pgTable("role_scopes", {
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  roleId: uuid("role_id").notNull().references(() => roles.id),
  scope: text("scope").notNull(),
}, (t) => [primaryKey({ columns: [t.roleId, t.scope] })]);

export const principalRoles = pgTable("principal_roles", {
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  principalId: uuid("principal_id").notNull().references(() => principals.id),
  roleId: uuid("role_id").notNull().references(() => roles.id),
}, (t) => [primaryKey({ columns: [t.principalId, t.roleId] })]);

export const agentPolicies = pgTable("agent_policies", {
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  principalId: uuid("principal_id").primaryKey().references(() => principals.id),
  allowedTools: text("allowed_tools").array(),
  autoCommitEnabled: boolean("auto_commit_enabled").notNull().default(false),
  maxAutoOrderValue: numeric("max_auto_order_value", { precision: 14, scale: 2, mode: "number" }),
  rateLimitPerHour: integer("rate_limit_per_hour"),
  killedAt: timestamp("killed_at", { withTimezone: true }),
});

export const customers = pgTable("customers", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  name: text("name").notNull(),
  normalizedName: text("normalized_name").notNull(),
  emailDomains: text("email_domains").array().notNull().default([]),
  billingAddress: jsonb("billing_address").$type<Record<string, unknown> | null>(),
  shipTo: jsonb("ship_to").$type<unknown[]>().notNull().default([]),
  defaultPriceListId: uuid("default_price_list_id"),
  paymentTerms: text("payment_terms"),
  status: text("status", { enum: ["active", "inactive"] }).notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("customers_tenant_idx").on(t.tenantId)]);

export const customerContacts = pgTable("customer_contacts", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  customerId: uuid("customer_id").notNull().references(() => customers.id),
  email: text("email").notNull(),
  name: text("name"),
});

export const products = pgTable("products", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  sku: text("sku").notNull(),
  skuNorm: text("sku_norm").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  baseUom: text("base_uom").notNull().default("EA"),
  barcode: text("barcode"),
  packFactors: jsonb("pack_factors").$type<Record<string, number>>().notNull().default({}),
  listPrice: money("list_price"),
  status: text("status", { enum: ["active", "inactive"] }).notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("products_tenant_sku_norm_idx").on(t.tenantId, t.skuNorm)]);

export const productAliases = pgTable("product_aliases", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  productId: uuid("product_id").notNull().references(() => products.id),
  customerId: uuid("customer_id").references(() => customers.id),
  aliasType: text("alias_type", { enum: ["customer_part_no", "description", "synonym"] }).notNull(),
  aliasNorm: text("alias_norm").notNull(),
  uomOverride: text("uom_override"),
  source: text("source", { enum: ["correction", "import", "inferred"] }).notNull(),
  createdFromCorrectionId: uuid("created_from_correction_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const priceLists = pgTable("price_lists", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  name: text("name").notNull(),
  currency: char("currency", { length: 3 }).notNull(),
  isDefault: boolean("is_default").notNull().default(false),
  validFrom: date("valid_from"),
  validTo: date("valid_to"),
});

export const priceListItems = pgTable("price_list_items", {
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  priceListId: uuid("price_list_id").notNull().references(() => priceLists.id),
  productId: uuid("product_id").notNull().references(() => products.id),
  minQty: money("min_qty").notNull().default(0),
  unitPrice: money("unit_price").notNull(),
  uom: text("uom"),
}, (t) => [primaryKey({ columns: [t.priceListId, t.productId, t.minQty] })]);

export const customerPriceLists = pgTable("customer_price_lists", {
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  customerId: uuid("customer_id").notNull().references(() => customers.id),
  priceListId: uuid("price_list_id").notNull().references(() => priceLists.id),
  priority: integer("priority").notNull().default(0),
}, (t) => [primaryKey({ columns: [t.customerId, t.priceListId] })]);

export const stockSnapshots = pgTable("stock_snapshots", {
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  productId: uuid("product_id").notNull().references(() => products.id),
  location: text("location").notNull().default("default"),
  qtyAvailable: money("qty_available").notNull(),
  asOf: timestamp("as_of", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.productId, t.location] })]);

export const documents = pgTable("documents", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  kind: text("kind").notNull(),
  storageKey: text("storage_key").notNull(),
  sha256: text("sha256").notNull(),
  mime: text("mime").notNull(),
  filename: text("filename"),
  parentDocumentId: uuid("parent_document_id"),
  textKey: text("text_key"),
  pageCount: integer("page_count"),
  fromAddress: text("from_address"),
  providerMessageId: text("provider_message_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const orders = pgTable("orders", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  number: text("number").notNull(),
  customerId: uuid("customer_id").notNull().references(() => customers.id),
  status: text("status").notNull(),
  customerPoNumber: text("customer_po_number"),
  currency: char("currency", { length: 3 }).notNull(),
  requestedDate: date("requested_date"),
  shipTo: jsonb("ship_to"),
  totals: jsonb("totals").$type<Record<string, unknown>>().notNull().default({}),
  createdFromProposalId: uuid("created_from_proposal_id").unique(),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const orderLines = pgTable("order_lines", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  orderId: uuid("order_id").notNull().references(() => orders.id),
  lineNo: integer("line_no").notNull(),
  productId: uuid("product_id").references(() => products.id),
  description: text("description").notNull(),
  qty: money("qty").notNull(),
  uom: text("uom").notNull(),
  unitPrice: money("unit_price"),
  lineTotal: money("line_total"),
  matchMethod: text("match_method"),
  matchConfidence: numeric("match_confidence", { precision: 5, scale: 4, mode: "number" }),
  evidence: jsonb("evidence"),
});

export const events = pgTable("events", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  type: text("type").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  idempotencyKey: text("idempotency_key").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agentRuns = pgTable("agent_runs", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  principalId: uuid("principal_id").notNull().references(() => principals.id),
  triggerEventId: uuid("trigger_event_id").references(() => events.id),
  workflow: text("workflow").notNull(),
  status: text("status").notNull(),
  attempt: integer("attempt").notNull().default(1),
  promptVersion: text("prompt_version"),
  policyVersion: text("policy_version"),
  modelId: text("model_id"),
  tokenUsage: jsonb("token_usage"),
  costUsd: numeric("cost_usd", { precision: 10, scale: 4, mode: "number" }),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const runSteps = pgTable("run_steps", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  runId: uuid("run_id").notNull().references(() => agentRuns.id),
  seq: integer("seq").notNull(),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  input: jsonb("input"),
  output: jsonb("output"),
  idempotencyKey: text("idempotency_key").notNull(),
  status: text("status", { enum: ["ok", "error"] }).notNull(),
  durationMs: integer("duration_ms").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const proposals = pgTable("proposals", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  runId: uuid("run_id").references(() => agentRuns.id),
  kind: text("kind").notNull(),
  payload: jsonb("payload").notNull(),
  payloadSchemaVersion: integer("payload_schema_version").notNull().default(1),
  confidence: numeric("confidence", { precision: 5, scale: 4, mode: "number" }).notNull(),
  confidenceBreakdown: jsonb("confidence_breakdown").notNull(),
  flags: text("flags").array().notNull().default([]),
  explanation: text("explanation").notNull().default(""),
  policyResult: jsonb("policy_result").notNull(),
  status: text("status").notNull(),
  supersedesId: uuid("supersedes_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const provenanceEntries = pgTable("provenance_entries", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  entityVersion: integer("entity_version"),
  action: text("action").notNull(),
  runId: uuid("run_id"),
  stepId: uuid("step_id"),
  proposalId: uuid("proposal_id"),
  approvalId: uuid("approval_id"),
  policyVersion: text("policy_version"),
  promptVersion: text("prompt_version"),
  modelId: text("model_id"),
  sourceDocumentIds: uuid("source_document_ids").array().notNull().default([]),
  actorPrincipalId: uuid("actor_principal_id").notNull(),
  diff: jsonb("diff"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const idempotencyKeys = pgTable("idempotency_keys", {
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  principalId: uuid("principal_id").notNull(),
  tool: text("tool").notNull(),
  key: text("key").notNull(),
  requestHash: text("request_hash").notNull(),
  result: jsonb("result"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.tenantId, t.principalId, t.tool, t.key] })]);

export const toolInvocations = pgTable("tool_invocations", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  principalId: uuid("principal_id").notNull(),
  tool: text("tool").notNull(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
});

export const connectors = pgTable("connectors", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  kind: text("kind").notNull(),
  config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
  secretRef: text("secret_ref"),
  mode: text("mode", { enum: ["sandbox", "live"] }).notNull().default("sandbox"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const connectorMappings = pgTable("connector_mappings", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  connectorId: uuid("connector_id").notNull().references(() => connectors.id),
  entityType: text("entity_type").notNull(),
  internalId: uuid("internal_id").notNull(),
  externalId: text("external_id").notNull(),
  externalVersion: text("external_version"),
  syncHash: text("sync_hash"),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).notNull().defaultNow(),
});

export const writebacks = pgTable("writebacks", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  orderId: uuid("order_id").notNull().references(() => orders.id),
  connectorId: uuid("connector_id").notNull().references(() => connectors.id),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  status: text("status", { enum: ["pending", "sent", "confirmed", "failed"] }).notNull().default("pending"),
  externalId: text("external_id"),
  request: jsonb("request"),
  response: jsonb("response"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const autonomyGates = pgTable("autonomy_gates", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  segment: text("segment").notNull().default("default"),
  promptVersion: text("prompt_version"),
  policyVersion: text("policy_version"),
  modelId: text("model_id"),
  autoPrecision: numeric("auto_precision", { precision: 5, scale: 4, mode: "number" }),
  nCases: integer("n_cases").notNull().default(0),
  green: boolean("green").notNull().default(false),
  evaluatedAt: timestamp("evaluated_at", { withTimezone: true }).notNull().defaultNow(),
});
