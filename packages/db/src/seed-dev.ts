import { randomBytes } from "node:crypto";
import { sha256 } from "@ai-erp/core";
import { DEFAULT_AGENT_TOOLS } from "@ai-erp/core";
import { createPostgresDb } from "./client.js";

/**
 * Creates a demo tenant with an admin human (API key printed once), an intake agent with a
 * policy, and the inbound-email service principal. Idempotent per slug.
 */
const url = process.env["DATABASE_ADMIN_URL"] ?? process.env["DATABASE_URL"];
if (!url) throw new Error("DATABASE_ADMIN_URL is required");
const slug = process.argv[2] ?? "demo";
const { sql, close } = createPostgresDb(url);

const [tenant] = await sql`INSERT INTO tenants (slug, name, autonomy_level, settings) VALUES (${slug}, ${`${slug} tenant`}, 1, '{"defaultCurrency":"USD"}')
  ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`;
const tenantId = tenant!["id"] as string;

const principal = async (kind: string, name: string) => {
  const rows = await sql`SELECT id FROM principals WHERE tenant_id = ${tenantId} AND kind = ${kind} AND display_name = ${name}`;
  if (rows[0]) return rows[0]["id"] as string;
  const [r] = await sql`INSERT INTO principals (tenant_id, kind, display_name) VALUES (${tenantId}, ${kind}, ${name}) RETURNING id`;
  return r!["id"] as string;
};
const admin = await principal("human", "admin");
const agent = await principal("agent", "intake-bot");
const inbound = await principal("service", "inbound-email");

const role = async (name: string, scopes: string[], principalId: string) => {
  const [r] = await sql`INSERT INTO roles (tenant_id, name) VALUES (${tenantId}, ${name}) ON CONFLICT (tenant_id, name) DO UPDATE SET name = EXCLUDED.name RETURNING id`;
  const roleId = r!["id"] as string;
  for (const scope of scopes) await sql`INSERT INTO role_scopes (tenant_id, role_id, scope) VALUES (${tenantId}, ${roleId}, ${scope}) ON CONFLICT DO NOTHING`;
  await sql`INSERT INTO principal_roles (tenant_id, principal_id, role_id) VALUES (${tenantId}, ${principalId}, ${roleId}) ON CONFLICT DO NOTHING`;
};
await role("admin", ["admin"], admin);
await role("intake-agent", ["customers:read", "products:read", "orders:propose", "documents:write"], agent);
await role("inbound", ["documents:write"], inbound);
await sql`INSERT INTO agent_policies (tenant_id, principal_id, allowed_tools, auto_commit_enabled, max_auto_order_value, rate_limit_per_hour)
  VALUES (${tenantId}, ${agent}, ${DEFAULT_AGENT_TOOLS}, false, 2500, 600) ON CONFLICT (principal_id) DO NOTHING`;
await sql`INSERT INTO price_lists (tenant_id, name, currency, is_default) SELECT ${tenantId}, 'Standard', 'USD', true WHERE NOT EXISTS (SELECT 1 FROM price_lists WHERE tenant_id = ${tenantId} AND is_default)`;
await sql`UPDATE tenants SET settings = settings || ${JSON.stringify({ intakeAgentPrincipalId: agent })}::jsonb WHERE id = ${tenantId}`;

const key = `aierp_${randomBytes(24).toString("hex")}`;
await sql`INSERT INTO api_keys (tenant_id, principal_id, key_hash, scopes) VALUES (${tenantId}, ${admin}, ${sha256(key)}, '{}')`;
const agentKey = `aierp_agent_${randomBytes(24).toString("hex")}`;
await sql`INSERT INTO api_keys (tenant_id, principal_id, key_hash, scopes) VALUES (${tenantId}, ${agent}, ${sha256(agentKey)}, '{}')`;

console.log(JSON.stringify({ tenantId, slug, adminApiKey: key, agentApiKey: agentKey, inboundAddress: `orders+${slug}@in.example.com` }, null, 2));
await close();
