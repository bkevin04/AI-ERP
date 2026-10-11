import { ToolRegistry } from "../define.js";
import { createOrderProposal } from "./create_order_proposal.js";
import { findCustomer } from "./find_customer.js";
import { ingestDocument } from "./ingest_document.js";
import { matchProductLineTool } from "./match_product_line.js";

export { createOrderProposal, findCustomer, ingestDocument, matchProductLineTool };

export function createDefaultRegistry(): ToolRegistry {
  return new ToolRegistry()
    .register(findCustomer)
    .register(matchProductLineTool)
    .register(createOrderProposal)
    .register(ingestDocument);
}

/** Tools an agent principal gets by default. Approval and commit are never in this list. */
export const DEFAULT_AGENT_TOOLS = [findCustomer.name, matchProductLineTool.name, createOrderProposal.name, ingestDocument.name];
