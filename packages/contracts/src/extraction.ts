import { z } from "zod";

/**
 * LLM-facing schemas. Every field is required and nullable (no optionals, no defaults)
 * so they compile to strict JSON schemas for structured outputs.
 */

export const ExtractedLine = z.object({
  raw_sku: z.string().nullable().describe("Part or item number exactly as written, or null"),
  raw_description: z.string().nullable().describe("Item description exactly as written, or null"),
  qty: z.number().describe("Quantity ordered as a number"),
  raw_uom: z.string().nullable().describe("Unit of measure exactly as written (EA, CS, box, ...), or null"),
  stated_unit_price: z.number().nullable().describe("Unit price stated on the document, or null"),
  evidence: z.string().describe("Short verbatim quote from the document that supports this line"),
});
export type ExtractedLine = z.infer<typeof ExtractedLine>;

export const CustomerHints = z.object({
  name: z.string().nullable(),
  email: z.string().nullable(),
  account_number: z.string().nullable(),
  address_lines: z.array(z.string()),
});

export const ShipToHints = z.object({
  name: z.string().nullable(),
  address_lines: z.array(z.string()),
  postal_code: z.string().nullable(),
  country: z.string().nullable(),
});

export const ExtractedOrder = z.object({
  customer: CustomerHints,
  customer_po_number: z.string().nullable(),
  order_date: z.string().nullable().describe("ISO date YYYY-MM-DD if present"),
  requested_delivery_date: z.string().nullable().describe("ISO date YYYY-MM-DD if present"),
  ship_to: ShipToHints.nullable(),
  currency: z.string().nullable().describe("ISO 4217 code if stated"),
  lines: z.array(ExtractedLine),
  notes: z.string().nullable(),
  language: z.string().describe("BCP-47 language tag of the document"),
});
export type ExtractedOrder = z.infer<typeof ExtractedOrder>;

export const TriageResult = z.object({
  is_order: z.boolean(),
  order_bearing_document_indexes: z.array(z.number().int()),
  language: z.string(),
  reason: z.string(),
});
export type TriageResult = z.infer<typeof TriageResult>;

export const DisambiguationResult = z.object({
  chosen_candidate_index: z.number().int().nullable().describe("Index into the candidate list, or null to abstain"),
  reason: z.string(),
});
export type DisambiguationResult = z.infer<typeof DisambiguationResult>;
