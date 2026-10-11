import { z } from "zod";
import { Uuid } from "./primitives.js";

export const AutonomyLevel = z.union([z.literal(0), z.literal(1), z.literal(2)]);
export type AutonomyLevel = z.infer<typeof AutonomyLevel>;

export const Tenant = z.object({
  id: Uuid,
  slug: z.string(),
  name: z.string(),
  autonomyLevel: AutonomyLevel,
  agentsPausedAt: z.date().nullable(),
  settings: z.record(z.string(), z.unknown()),
});
export type Tenant = z.infer<typeof Tenant>;

export const PrincipalKind = z.enum(["human", "agent", "service"]);
export type PrincipalKind = z.infer<typeof PrincipalKind>;

export const Principal = z.object({
  id: Uuid,
  tenantId: Uuid,
  kind: PrincipalKind,
  displayName: z.string(),
  email: z.string().nullable(),
  status: z.enum(["active", "disabled"]),
});
export type Principal = z.infer<typeof Principal>;

export const Scope = z.enum([
  "customers:read",
  "products:read",
  "orders:read",
  "orders:propose",
  "orders:approve",
  "orders:commit",
  "documents:write",
  "connectors:write",
  "admin",
]);
export type Scope = z.infer<typeof Scope>;

export const AgentPolicy = z.object({
  principalId: Uuid,
  /** null means "any tool the scopes allow". */
  allowedTools: z.array(z.string()).nullable(),
  autoCommitEnabled: z.boolean(),
  maxAutoOrderValue: z.number().nullable(),
  rateLimitPerHour: z.number().int().nullable(),
  killedAt: z.date().nullable(),
});
export type AgentPolicy = z.infer<typeof AgentPolicy>;
