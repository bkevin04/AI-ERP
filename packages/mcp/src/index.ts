import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ToolError, invokeTool, type InvokeEnv, type ToolRegistry } from "@ai-erp/core";

export interface McpServerOptions {
  registry: ToolRegistry;
  /** Resolves the caller's environment (tenant, principal, store). The MCP caller is a principal like any other. */
  resolveEnv: () => Promise<InvokeEnv>;
  name?: string;
  version?: string;
}

/**
 * Exposes every tool with `mcp` exposure over the Model Context Protocol. The same
 * `invokeTool` choke point runs underneath, so an external agent gets exactly the
 * permissions, idempotency and provenance a UI click gets.
 */
export function createMcpServer(opts: McpServerOptions): Server {
  const server = new Server({ name: opts.name ?? "ai-erp", version: opts.version ?? "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: opts.registry.describeAll("mcp").map((d) => ({
      name: d.name,
      description: `${d.description} [scope ${d.scope}; side effects: ${d.sideEffects}${d.idempotency === "required" ? "; requires _idempotency_key" : ""}]`,
      inputSchema: withIdempotencyKey(d.inputSchema, d.idempotency),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = { ...(req.params.arguments ?? {}) } as Record<string, unknown>;
    const idempotencyKey = typeof args["_idempotency_key"] === "string" ? (args["_idempotency_key"] as string) : undefined;
    delete args["_idempotency_key"];
    try {
      const env = await opts.resolveEnv();
      const tool = opts.registry.get(req.params.name);
      if (!tool || !tool.exposure.includes("mcp")) throw new ToolError("not_found", `unknown tool: ${req.params.name}`);
      const r = await invokeTool(env, req.params.name, args, { idempotencyKey });
      return { content: [{ type: "text", text: JSON.stringify(r.output) }], structuredContent: r.output as Record<string, unknown> };
    } catch (err) {
      if (err instanceof ToolError) {
        return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: err.code, message: err.message, details: err.details ?? null }) }] };
      }
      throw err;
    }
  });

  return server;
}

function withIdempotencyKey(schema: Record<string, unknown>, idempotency: string): { type: "object"; properties: Record<string, unknown>; required?: string[] } {
  const props = { ...((schema["properties"] as Record<string, unknown>) ?? {}) };
  const required = [...((schema["required"] as string[]) ?? [])];
  if (idempotency !== "none") {
    props["_idempotency_key"] = { type: "string", description: "Client-chosen key; repeating a call with the same key returns the first result." };
    if (idempotency === "required") required.push("_idempotency_key");
  }
  return { type: "object", properties: props, required };
}
