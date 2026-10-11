import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDefaultRegistry } from "@ai-erp/core";
import { MemoryDb } from "@ai-erp/core/testing";
import { createMcpServer } from "../src/index.js";

async function connected() {
  const db = new MemoryDb();
  const tenant = db.addTenant();
  const principal = db.addPrincipal({ tenantId: tenant.id, kind: "agent", scopes: ["customers:read"] });
  db.addCustomer({ tenantId: tenant.id, name: "Acme", emailDomains: ["acme.com"] });
  const registry = createDefaultRegistry();
  const server = createMcpServer({ registry, resolveEnv: async () => ({ registry, store: db.forTenant(tenant.id), tenant, principal }) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, db };
}

describe("MCP adapter", () => {
  it("lists tools with json schemas and the idempotency key field", async () => {
    const { client } = await connected();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["create_order_proposal", "find_customer", "ingest_document", "match_product_line"]);
    const proposal = tools.find((t) => t.name === "create_order_proposal")!;
    expect((proposal.inputSchema as { required?: string[] }).required).toContain("_idempotency_key");
  });

  it("calls through invokeTool and surfaces permission errors as tool errors", async () => {
    const { client } = await connected();
    const ok = await client.callTool({ name: "find_customer", arguments: { email: "x@acme.com" } });
    expect(ok.isError).toBeFalsy();
    expect((ok.structuredContent as { best: { name: string } }).best.name).toBe("Acme");
    const denied = await client.callTool({ name: "match_product_line", arguments: { qty: 1 } });
    expect(denied.isError).toBe(true);
    expect(String((denied.content as Array<{ text: string }>)[0]!.text)).toContain("forbidden");
  });
});
