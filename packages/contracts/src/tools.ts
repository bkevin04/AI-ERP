import { z } from "zod";
import { Scope } from "./identity.js";

export const ToolExposure = z.enum(["http", "agent", "mcp"]);
export type ToolExposure = z.infer<typeof ToolExposure>;

export const SideEffects = z.enum(["none", "write", "external"]);
export type SideEffects = z.infer<typeof SideEffects>;

export const ToolDescriptor = z.object({
  name: z.string(),
  description: z.string(),
  scope: Scope,
  sideEffects: SideEffects,
  exposure: z.array(ToolExposure),
  idempotency: z.enum(["none", "optional", "required"]),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()),
});
export type ToolDescriptor = z.infer<typeof ToolDescriptor>;
