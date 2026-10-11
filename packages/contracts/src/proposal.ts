import { z } from "zod";
import { Address, Currency, IsoDate, Uuid } from "./primitives.js";

export const MatchMethod = z.enum([
  "contact_email",
  "sender_domain",
  "name_postal",
  "po_prefix",
  "customer_alias",
  "sku_exact",
  "barcode",
  "tenant_alias",
  "search",
  "llm_pick",
  "unmatched",
]);
export type MatchMethod = z.infer<typeof MatchMethod>;

export const CustomerCandidate = z.object({
  customerId: Uuid,
  name: z.string(),
  score: z.number().min(0).max(1),
  method: MatchMethod,
});
export type CustomerCandidate = z.infer<typeof CustomerCandidate>;

export const ProductCandidate = z.object({
  productId: Uuid,
  sku: z.string(),
  name: z.string(),
  score: z.number().min(0).max(1),
  method: MatchMethod,
});
export type ProductCandidate = z.infer<typeof ProductCandidate>;

export const LineFlag = z.enum([
  "unmatched_product",
  "low_confidence_match",
  "uom_unknown",
  "uom_pack_mismatch",
  "qty_suspicious",
  "price_mismatch",
  "price_unknown",
  "stock_short",
  "llm_abstained",
]);
export type LineFlag = z.infer<typeof LineFlag>;

export const OrderFlag = z.enum([
  "customer_unresolved",
  "customer_low_confidence",
  "customer_inactive",
  "duplicate_po",
  "no_lines",
  "ship_to_unresolved",
  "over_agent_value_cap",
]);
export type OrderFlag = z.infer<typeof OrderFlag>;

export const OrderDraftLine = z.object({
  lineNo: z.number().int(),
  rawSku: z.string().nullable(),
  rawDescription: z.string().nullable(),
  productId: Uuid.nullable(),
  sku: z.string().nullable(),
  description: z.string(),
  qty: z.number(),
  uom: z.string(),
  rawUom: z.string().nullable(),
  statedUnitPrice: z.number().nullable(),
  expectedUnitPrice: z.number().nullable(),
  unitPrice: z.number().nullable(),
  lineTotal: z.number().nullable(),
  matchMethod: MatchMethod,
  matchConfidence: z.number().min(0).max(1),
  candidates: z.array(ProductCandidate),
  flags: z.array(LineFlag),
  evidence: z.string().nullable(),
});
export type OrderDraftLine = z.infer<typeof OrderDraftLine>;

export const OrderDraft = z.object({
  customerId: Uuid.nullable(),
  customerMatch: z.object({
    method: MatchMethod,
    confidence: z.number().min(0).max(1),
    candidates: z.array(CustomerCandidate),
  }),
  customerPoNumber: z.string().nullable(),
  orderDate: IsoDate.nullable(),
  requestedDate: IsoDate.nullable(),
  shipTo: Address.nullable(),
  currency: Currency,
  lines: z.array(OrderDraftLine),
  totals: z.object({ subtotal: z.number(), lineCount: z.number().int() }),
  flags: z.array(OrderFlag),
  sourceDocumentIds: z.array(Uuid),
});
export type OrderDraft = z.infer<typeof OrderDraft>;

export const ConfidenceBreakdown = z.object({
  customer: z.number().min(0).max(1),
  linesMin: z.number().min(0).max(1),
  penalties: z.array(z.object({ flag: z.string(), penalty: z.number() })),
  overall: z.number().min(0).max(1),
});
export type ConfidenceBreakdown = z.infer<typeof ConfidenceBreakdown>;

export const PolicyDecision = z.enum(["auto", "review", "block"]);
export type PolicyDecision = z.infer<typeof PolicyDecision>;

export const PolicyReason = z.object({
  code: z.string(),
  message: z.string(),
  severity: z.enum(["info", "review", "block"]),
});
export type PolicyReason = z.infer<typeof PolicyReason>;

export const PolicyResult = z.object({
  decision: PolicyDecision,
  reasons: z.array(PolicyReason),
  policyVersion: z.string(),
});
export type PolicyResult = z.infer<typeof PolicyResult>;

export const ProposalStatus = z.enum([
  "proposed",
  "checks_failed",
  "pending_approval",
  "auto_approved",
  "approved",
  "rejected",
  "committed",
  "superseded",
]);
export type ProposalStatus = z.infer<typeof ProposalStatus>;

export const ProposalKind = z.enum(["create_order"]);

export const Proposal = z.object({
  id: Uuid,
  tenantId: Uuid,
  runId: Uuid.nullable(),
  kind: ProposalKind,
  payload: OrderDraft,
  payloadSchemaVersion: z.number().int(),
  confidence: z.number().min(0).max(1),
  confidenceBreakdown: ConfidenceBreakdown,
  flags: z.array(z.string()),
  explanation: z.string(),
  policyResult: PolicyResult,
  status: ProposalStatus,
  supersedesId: Uuid.nullable(),
});
export type Proposal = z.infer<typeof Proposal>;
