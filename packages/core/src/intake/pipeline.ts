import type {
  Address,
  CustomerCandidate,
  ExtractedOrder,
  LineFlag,
  OrderDraft,
  OrderDraftLine,
  OrderFlag,
  PolicyResult,
  ProposalStatus,
} from "@ai-erp/contracts";
import { matchCustomer } from "../matching/customer.js";
import { applyPick, matchProductLine, type ProductLineMatch } from "../matching/product.js";
import { priceLine } from "../pricing/engine.js";
import type { StepRunner } from "../runs/executor.js";
import type { CoreStore, CustomerSummary, PrincipalContext, TenantInfo } from "../store.js";
import { invokeTool } from "../tools/invoke.js";
import type { ToolRegistry } from "../tools/define.js";
import { round2 } from "../util.js";
import type { LlmPort, PreparedDocument } from "./llm-port.js";

export interface IntakeEnv {
  registry: ToolRegistry;
  store: CoreStore;
  llm: LlmPort;
  tenant: TenantInfo;
  /** The agent principal the run executes as. */
  principal: PrincipalContext;
  steps: StepRunner;
  globalPause?: boolean;
  now?: () => Date;
}

export interface IntakeInput {
  documents: PreparedDocument[];
  senderEmail: string | null;
}

export type IntakeOutcome =
  | { kind: "noop"; reason: string }
  | {
      kind: "proposal";
      proposalId: string;
      status: ProposalStatus;
      confidence: number;
      policyResult: PolicyResult;
      draft: OrderDraft;
    };

export interface CreateOrderProposalOutput {
  proposalId: string;
  status: ProposalStatus;
  confidence: number;
  policyResult: PolicyResult;
}

/**
 * Order intake, end to end: triage → extract → resolve → (disambiguate) → propose.
 * The model only ever sees documents and candidate lists; every write goes through
 * `invokeTool`, so permissions and provenance are enforced in one place.
 */
export async function runOrderIntake(env: IntakeEnv, input: IntakeInput): Promise<IntakeOutcome> {
  const { steps, store, llm } = env;
  const docIds = input.documents.map((d) => d.id);

  const triage = await steps.step("triage", "llm_call", { docIds }, () => llm.triage(input.documents));
  if (!triage.result.is_order) return { kind: "noop", reason: triage.result.reason };

  const orderDocs = triage.result.order_bearing_document_indexes
    .map((i) => input.documents[i])
    .filter((d): d is PreparedDocument => !!d);
  const docsForExtraction = orderDocs.length > 0 ? orderDocs : input.documents;

  const extraction = await steps.step("extract", "llm_call", { docIds: docsForExtraction.map((d) => d.id) }, () =>
    llm.extractOrder(docsForExtraction, { fewShots: [] }),
  );
  const extracted = extraction.result;

  // --- customer -------------------------------------------------------------
  const customerHints = {
    email: extracted.customer.email,
    senderEmail: input.senderEmail,
    name: extracted.customer.name,
    postalCode: extracted.ship_to?.postal_code ?? null,
    poNumber: extracted.customer_po_number,
    accountNumber: extracted.customer.account_number,
  };
  let customerMatch = await steps.step("match_customer", "code", customerHints, () => matchCustomer(store, customerHints));
  if (!customerMatch.best && customerMatch.candidates.length > 0) {
    const pick = await steps.step("disambiguate_customer", "llm_call", { candidates: customerMatch.candidates }, () =>
      llm.disambiguateCustomer({ hints: extracted.customer, senderEmail: input.senderEmail, candidates: customerMatch.candidates }),
    );
    const idx = pick.result.chosen_candidate_index;
    const chosen = idx === null ? undefined : customerMatch.candidates[idx];
    if (chosen) {
      const best: CustomerCandidate = { ...chosen, score: Math.min(0.65, chosen.score), method: "llm_pick" };
      customerMatch = { best, candidates: customerMatch.candidates };
    }
  }
  const customer = customerMatch.best ? await store.getCustomer(customerMatch.best.customerId) : null;
  const customerId = customer?.id ?? null;

  // --- lines ----------------------------------------------------------------
  const lines: OrderDraftLine[] = [];
  for (const [i, line] of extracted.lines.entries()) {
    const lineInput = {
      customerId,
      rawSku: line.raw_sku,
      rawDescription: line.raw_description,
      qty: line.qty,
      rawUom: line.raw_uom,
    };
    let match: ProductLineMatch = await steps.step(`match_line_${i}`, "code", lineInput, () => matchProductLine(store, lineInput));
    if (!match.best && match.candidates.length > 0) {
      const pick = await steps.step(`disambiguate_line_${i}`, "llm_call", { candidates: match.candidates }, () =>
        llm.disambiguateProduct({ line, candidates: match.candidates }),
      );
      const idx = pick.result.chosen_candidate_index;
      const chosen = idx === null ? undefined : match.candidates[idx];
      const product = chosen ? await store.getProduct(chosen.productId) : null;
      match = applyPick(match, chosen && product ? { productId: chosen.productId, product } : null, lineInput);
    }

    const flags: LineFlag[] = [...match.flags];
    let unitPrice: number | null = line.stated_unit_price;
    let expectedUnitPrice: number | null = null;
    if (match.product) {
      const priceInput = { customerId, productId: match.product.id, qty: match.qty, statedUnitPrice: line.stated_unit_price };
      const price = await steps.step(`price_line_${i}`, "code", priceInput, () => priceLine(store, priceInput));
      unitPrice = price.unitPrice;
      expectedUnitPrice = price.expectedUnitPrice;
      flags.push(...price.flags);
      const stock = await store.getStock(match.product.id);
      if (stock && stock.qtyAvailable < baseQty(match, match.product.packFactors)) flags.push("stock_short");
    }

    lines.push({
      lineNo: i + 1,
      rawSku: line.raw_sku,
      rawDescription: line.raw_description,
      productId: match.product?.id ?? null,
      sku: match.product?.sku ?? null,
      description: match.product?.name ?? line.raw_description ?? line.raw_sku ?? "(unidentified item)",
      qty: match.qty,
      uom: match.uom,
      rawUom: line.raw_uom,
      statedUnitPrice: line.stated_unit_price,
      expectedUnitPrice,
      unitPrice,
      lineTotal: unitPrice === null ? null : round2(unitPrice * match.qty),
      matchMethod: match.best?.method ?? "unmatched",
      matchConfidence: match.best?.score ?? 0,
      candidates: match.candidates,
      flags: [...new Set(flags)],
      evidence: line.evidence,
    });
  }

  // --- order-level flags ------------------------------------------------------
  const orderFlags: OrderFlag[] = [];
  if (!customerId) orderFlags.push("customer_unresolved");
  else if ((customerMatch.best?.score ?? 0) < 0.85) orderFlags.push("customer_low_confidence");
  if (customer && customer.status === "inactive") orderFlags.push("customer_inactive");
  if (lines.length === 0) orderFlags.push("no_lines");
  if (customerId && extracted.customer_po_number) {
    const dup = await store.findOrderByCustomerPo(customerId, extracted.customer_po_number);
    if (dup) orderFlags.push("duplicate_po");
  }
  const shipTo = resolveShipTo(extracted, customer);
  if (!shipTo) orderFlags.push("ship_to_unresolved");

  const draft: OrderDraft = {
    customerId,
    customerMatch: {
      method: customerMatch.best?.method ?? "unmatched",
      confidence: customerMatch.best?.score ?? 0,
      candidates: customerMatch.candidates,
    },
    customerPoNumber: extracted.customer_po_number,
    orderDate: isoDateOrNull(extracted.order_date),
    requestedDate: isoDateOrNull(extracted.requested_delivery_date),
    shipTo,
    currency: extracted.currency?.toUpperCase().slice(0, 3) ?? defaultCurrency(env.tenant),
    lines,
    totals: { subtotal: round2(lines.reduce((s, l) => s + (l.lineTotal ?? 0), 0)), lineCount: lines.length },
    flags: orderFlags,
    sourceDocumentIds: docIds,
  };

  const explanation = buildExplanation(draft, extraction.meta.model);
  const { output } = await invokeTool<CreateOrderProposalOutput>(
    {
      registry: env.registry,
      store: env.store,
      tenant: env.tenant,
      principal: env.principal,
      run: steps.run,
      globalPause: env.globalPause,
      now: env.now,
    },
    "create_order_proposal",
    { draft, explanation, promptVersion: extraction.meta.promptVersion, modelId: extraction.meta.model },
    { idempotencyKey: `run:${steps.run.id}:proposal`, sourceDocumentIds: docIds },
  );

  return { kind: "proposal", proposalId: output.proposalId, status: output.status, confidence: output.confidence, policyResult: output.policyResult, draft };
}

function baseQty(match: ProductLineMatch, packFactors: Record<string, number>): number {
  const factor = packFactors[match.uom];
  return factor ? match.qty * factor : match.qty;
}

function isoDateOrNull(s: string | null): string | null {
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function defaultCurrency(tenant: TenantInfo): string {
  const c = tenant.settings["defaultCurrency"];
  return typeof c === "string" && c.length === 3 ? c.toUpperCase() : "USD";
}

function resolveShipTo(extracted: ExtractedOrder, customer: CustomerSummary | null): Address | null {
  const hints = extracted.ship_to;
  if (hints && hints.address_lines.length >= 2 && hints.postal_code) {
    return {
      name: hints.name,
      line1: hints.address_lines[0]!,
      line2: hints.address_lines.length > 2 ? hints.address_lines.slice(1, -1).join(", ") : null,
      city: hints.address_lines[hints.address_lines.length - 1]!,
      region: null,
      postalCode: hints.postal_code,
      country: hints.country ?? customer?.shipTo[0]?.country ?? "",
    };
  }
  return customer?.shipTo[0] ?? null;
}

function buildExplanation(draft: OrderDraft, model: string): string {
  const parts: string[] = [];
  parts.push(
    draft.customerId
      ? `Customer matched by ${draft.customerMatch.method} (${draft.customerMatch.confidence.toFixed(2)}).`
      : `Customer could not be resolved; ${draft.customerMatch.candidates.length} candidate(s) listed.`,
  );
  const matched = draft.lines.filter((l) => l.productId).length;
  parts.push(`${matched}/${draft.lines.length} lines matched to products.`);
  const flagged = draft.lines.filter((l) => l.flags.length > 0).length;
  if (flagged) parts.push(`${flagged} line(s) carry flags for review.`);
  if (draft.flags.length) parts.push(`Order flags: ${draft.flags.join(", ")}.`);
  parts.push(`Extraction by ${model}; matching, pricing and policy by deterministic code.`);
  return parts.join(" ");
}
