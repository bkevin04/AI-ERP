import type { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "@ai-erp/mcp";
import { ToolError, sha256 } from "@ai-erp/core";
import type { ApiDeps } from "./deps.js";
import { envForPrincipal } from "./app.js";

/**
 * Mounts the MCP endpoint. Stateless transport: each request builds a server bound to the
 * caller's principal, so permissions are the caller's and nothing is shared across tenants.
 */
export function mountMcp(app: Hono<{ Bindings: HttpBindings }>, deps: ApiDeps): void {
  app.all("/mcp", async (c) => {
    const header = c.req.header("authorization") ?? "";
    const key = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
    const principal = key ? await deps.store.resolvePrincipalByApiKeyHash(sha256(key)) : null;
    const env = await envForPrincipal(deps, principal);
    if (!env) return c.json({ error: "unauthorized" }, 401);

    const server = createMcpServer({
      registry: deps.registry,
      resolveEnv: async () => env,
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    const body = c.req.method === "POST" ? await c.req.json().catch(() => undefined) : undefined;
    await transport.handleRequest(c.env.incoming, c.env.outgoing, body);
    c.env.outgoing.on("close", () => { void transport.close(); void server.close(); });
    return RESPONSE_ALREADY_SENT;
  });
}

// Hono's node adapter recognises this sentinel when the raw response was written directly.
const RESPONSE_ALREADY_SENT = new Response(null, { status: 200 });

export { ToolError };
