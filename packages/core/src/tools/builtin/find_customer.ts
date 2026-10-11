import { z } from "zod";
import { CustomerCandidate } from "@ai-erp/contracts";
import { matchCustomer } from "../../matching/customer.js";
import { defineTool } from "../define.js";

export const findCustomer = defineTool({
  name: "find_customer",
  description: "Resolve a customer from an email address, company name, postal code or PO number. Returns ranked candidates; `best` is set only when the match is decisive.",
  scope: "customers:read",
  sideEffects: "none",
  exposure: ["http", "agent", "mcp"],
  input: z.object({
    email: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    postalCode: z.string().nullable().optional(),
    poNumber: z.string().nullable().optional(),
  }),
  output: z.object({ best: CustomerCandidate.nullable(), candidates: z.array(CustomerCandidate) }),
  handler: async (ctx, input) => matchCustomer(ctx.store, input),
});
