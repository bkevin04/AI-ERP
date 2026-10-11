import type { DisambiguationResult, ExtractedOrder, TriageResult } from "@ai-erp/contracts";
import type { LlmPort, LlmResult } from "../intake/llm-port.js";

const meta = { model: "fake-model", promptVersion: "test", inputTokens: null, outputTokens: null };

/** Scripted LLM for tests: returns what you configure and counts calls. */
export class FakeLlm implements LlmPort {
  calls: string[] = [];
  triageResult: TriageResult = { is_order: true, order_bearing_document_indexes: [0], language: "en", reason: "looks like a PO" };
  extraction: ExtractedOrder;
  productPick: DisambiguationResult = { chosen_candidate_index: 0, reason: "best match" };
  customerPick: DisambiguationResult = { chosen_candidate_index: null, reason: "unsure" };

  constructor(extraction: ExtractedOrder) {
    this.extraction = extraction;
  }

  async triage(): Promise<LlmResult<TriageResult>> {
    this.calls.push("triage");
    return { result: this.triageResult, meta };
  }
  async extractOrder(): Promise<LlmResult<ExtractedOrder>> {
    this.calls.push("extract");
    return { result: this.extraction, meta };
  }
  async disambiguateProduct(): Promise<LlmResult<DisambiguationResult>> {
    this.calls.push("disambiguateProduct");
    return { result: this.productPick, meta };
  }
  async disambiguateCustomer(): Promise<LlmResult<DisambiguationResult>> {
    this.calls.push("disambiguateCustomer");
    return { result: this.customerPick, meta };
  }
}

export function extractedOrder(overrides: Partial<ExtractedOrder> = {}): ExtractedOrder {
  return {
    customer: { name: null, email: null, account_number: null, address_lines: [] },
    customer_po_number: null,
    order_date: null,
    requested_delivery_date: null,
    ship_to: null,
    currency: null,
    lines: [],
    notes: null,
    language: "en",
    ...overrides,
  };
}
