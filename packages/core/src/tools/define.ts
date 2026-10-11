import { z } from "zod";
import type { Scope, SideEffects, ToolDescriptor, ToolExposure } from "@ai-erp/contracts";
import type { ToolContext } from "./context.js";

export type Idempotency = "none" | "optional" | "required";

export interface ToolDefinition<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  scope: Scope;
  sideEffects: SideEffects;
  exposure: ToolExposure[];
  idempotency: Idempotency;
  input: I;
  output: O;
  handler: (ctx: ToolContext, input: z.output<I>) => Promise<z.output<O>>;
}

export function defineTool<I extends z.ZodType, O extends z.ZodType>(
  def: Omit<ToolDefinition<I, O>, "idempotency"> & { idempotency?: Idempotency },
): ToolDefinition<I, O> {
  if (!/^[a-z][a-z0-9_]*$/.test(def.name)) {
    throw new Error(`tool name must be snake_case: ${def.name}`);
  }
  return { idempotency: "none", ...def };
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(def: ToolDefinition<any, any>): this {
    if (this.tools.has(def.name)) throw new Error(`tool already registered: ${def.name}`);
    this.tools.set(def.name, def);
    return this;
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(exposure?: ToolExposure): ToolDefinition[] {
    const all = [...this.tools.values()];
    return exposure ? all.filter((t) => t.exposure.includes(exposure)) : all;
  }

  describe(def: ToolDefinition): ToolDescriptor {
    return {
      name: def.name,
      description: def.description,
      scope: def.scope,
      sideEffects: def.sideEffects,
      exposure: def.exposure,
      idempotency: def.idempotency,
      inputSchema: z.toJSONSchema(def.input, { io: "input" }) as Record<string, unknown>,
      outputSchema: z.toJSONSchema(def.output, { io: "output" }) as Record<string, unknown>,
    };
  }

  describeAll(exposure?: ToolExposure): ToolDescriptor[] {
    return this.list(exposure).map((d) => this.describe(d));
  }
}
