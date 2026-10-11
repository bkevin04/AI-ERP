import type Anthropic from "@anthropic-ai/sdk";
import { DisambiguationResult, ExtractedOrder, TriageResult, type CustomerCandidate, type ExtractedLine, type ProductCandidate } from "@ai-erp/contracts";
import type { LlmPort, LlmResult, PreparedDocument } from "@ai-erp/core";
import { DEFAULT_MODELS, structuredCall, type LlmModels } from "./client.js";
import { documentsToContent } from "./documents.js";
import { DISAMBIGUATE_CUSTOMER_PROMPT, DISAMBIGUATE_PRODUCT_PROMPT, EXTRACT_ORDER_PROMPT, TRIAGE_PROMPT } from "./prompts/index.js";

export function createAnthropicLlmPort(client: Anthropic, models: LlmModels = DEFAULT_MODELS): LlmPort {
  return {
    async triage(docs: PreparedDocument[]): Promise<LlmResult<TriageResult>> {
      const r = await structuredCall({
        client, model: models.triage, system: TRIAGE_PROMPT.system, promptVersion: TRIAGE_PROMPT.version,
        content: documentsToContent(docs, "Classify the documents above."), schema: TriageResult, effort: "low", maxTokens: 1024,
      });
      return { result: r.result, meta: r.meta };
    },

    async extractOrder(docs: PreparedDocument[], opts: { fewShots: string[] }): Promise<LlmResult<ExtractedOrder>> {
      const system = opts.fewShots.length
        ? `${EXTRACT_ORDER_PROMPT.system}\n\nExamples the reviewer taught for this customer:\n${opts.fewShots.map((e) => `- ${e}`).join("\n")}`
        : EXTRACT_ORDER_PROMPT.system;
      const r = await structuredCall({
        client, model: models.extract, system, promptVersion: EXTRACT_ORDER_PROMPT.version,
        content: documentsToContent(docs, "Extract the purchase order from the documents above."), schema: ExtractedOrder, effort: "high",
      });
      return { result: r.result, meta: r.meta };
    },

    async disambiguateProduct(args: { line: ExtractedLine; candidates: ProductCandidate[] }): Promise<LlmResult<DisambiguationResult>> {
      const text = [
        "Order line:",
        JSON.stringify({ part_number: args.line.raw_sku, description: args.line.raw_description, qty: args.line.qty, unit: args.line.raw_uom }),
        "Candidates:",
        ...args.candidates.map((c, i) => `${i}. sku=${c.sku} name=${JSON.stringify(c.name)} (search score ${c.score.toFixed(2)})`),
        "Pick the candidate index or null.",
      ].join("\n");
      const r = await structuredCall({
        client, model: models.disambiguate, system: DISAMBIGUATE_PRODUCT_PROMPT.system, promptVersion: DISAMBIGUATE_PRODUCT_PROMPT.version,
        content: [{ type: "text", text }], schema: DisambiguationResult, effort: "medium", maxTokens: 1024,
      });
      return { result: r.result, meta: r.meta };
    },

    async disambiguateCustomer(args: { hints: ExtractedOrder["customer"]; senderEmail: string | null; candidates: CustomerCandidate[] }): Promise<LlmResult<DisambiguationResult>> {
      const text = [
        "Sender: " + (args.senderEmail ?? "unknown"),
        "Hints: " + JSON.stringify(args.hints),
        "Candidates:",
        ...args.candidates.map((c, i) => `${i}. ${JSON.stringify(c.name)} (matched by ${c.method}, score ${c.score.toFixed(2)})`),
        "Pick the candidate index or null.",
      ].join("\n");
      const r = await structuredCall({
        client, model: models.disambiguate, system: DISAMBIGUATE_CUSTOMER_PROMPT.system, promptVersion: DISAMBIGUATE_CUSTOMER_PROMPT.version,
        content: [{ type: "text", text }], schema: DisambiguationResult, effort: "medium", maxTokens: 1024,
      });
      return { result: r.result, meta: r.meta };
    },
  };
}
