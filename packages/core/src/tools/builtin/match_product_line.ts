import { z } from "zod";
import { LineFlag, ProductCandidate } from "@ai-erp/contracts";
import { matchProductLine } from "../../matching/product.js";
import { defineTool } from "../define.js";

export const matchProductLineTool = defineTool({
  name: "match_product_line",
  description: "Match one order line (part number, description, quantity, unit) to a product. Uses customer aliases, SKU, barcode and search in that order. Returns candidates when ambiguous.",
  scope: "products:read",
  sideEffects: "none",
  exposure: ["http", "agent", "mcp"],
  input: z.object({
    customerId: z.uuid().nullable().default(null),
    rawSku: z.string().nullable().default(null),
    rawDescription: z.string().nullable().default(null),
    qty: z.number(),
    rawUom: z.string().nullable().default(null),
  }),
  output: z.object({
    best: ProductCandidate.nullable(),
    candidates: z.array(ProductCandidate),
    qty: z.number(),
    uom: z.string(),
    flags: z.array(LineFlag),
  }),
  handler: async (ctx, input) => {
    const m = await matchProductLine(ctx.store, input);
    return { best: m.best, candidates: m.candidates, qty: m.qty, uom: m.uom, flags: m.flags };
  },
});
