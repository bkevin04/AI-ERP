import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import type { LlmMeta } from "@ai-erp/core";

export interface LlmModels {
  triage: string;
  extract: string;
  disambiguate: string;
}

export const DEFAULT_MODELS: LlmModels = {
  triage: process.env["LLM_TRIAGE_MODEL"] ?? "claude-haiku-5-5",
  extract: process.env["LLM_EXTRACT_MODEL"] ?? "claude-opus-5-5",
  disambiguate: process.env["LLM_DISAMBIGUATE_MODEL"] ?? "claude-opus-5-5",
};

export class LlmRefusedError extends Error {
  constructor(public readonly category: string | null, public readonly explanation: string | null) {
    super(`model declined the request${category ? ` (${category})` : ""}`);
    this.name = "LlmRefusedError";
  }
}

export class LlmOutputError extends Error {
  constructor(message: string, public readonly raw: string | null) {
    super(message);
    this.name = "LlmOutputError";
  }
}

/** Models that accept the server-side refusal fallback parameter. Haiku has no fallback. */
const FALLBACK_CAPABLE = /^claude-(opus-5-5|opus-5|sonnet-5-5|fable-5-1)$/;

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface StructuredCallArgs<T extends z.ZodType> {
  client: Anthropic;
  model: string;
  system: string;
  promptVersion: string;
  content: Anthropic.ContentBlockParam[];
  schema: T;
  effort: Effort;
  maxTokens?: number;
}

/**
 * One structured-output call: strict JSON schema from zod, refusal handling, and server-side
 * fallback on the models that support it. The response text is validated with the same
 * zod schema, so callers get a typed value or an error, never a partially-filled object.
 */
export async function structuredCall<T extends z.ZodType>(args: StructuredCallArgs<T>): Promise<{ result: z.output<T>; meta: LlmMeta; raw: string }> {
  const useFallback = FALLBACK_CAPABLE.test(args.model);
  const base = {
    model: args.model,
    max_tokens: args.maxTokens ?? 16000,
    system: args.system,
    messages: [{ role: "user" as const, content: args.content }],
    output_config: { effort: args.effort, format: zodOutputFormat(args.schema) },
  };

  const response = useFallback
    ? await args.client.beta.messages.create({ ...base, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } as never)
    : await args.client.messages.create(base);

  if (response.stop_reason === "refusal") {
    const details = (response as { stop_details?: { category?: string | null; explanation?: string | null } | null }).stop_details ?? null;
    throw new LlmRefusedError(details?.category ?? null, details?.explanation ?? null);
  }
  if (response.stop_reason === "max_tokens") {
    throw new LlmOutputError("model output was cut off by max_tokens", null);
  }
  const text = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch {
    throw new LlmOutputError("model output was not valid JSON", text);
  }
  const parsed = args.schema.safeParse(parsedJson);
  if (!parsed.success) throw new LlmOutputError(`model output did not match schema: ${parsed.error.message}`, text);

  return {
    result: parsed.data,
    raw: text,
    meta: {
      model: response.model,
      promptVersion: args.promptVersion,
      inputTokens: response.usage?.input_tokens ?? null,
      outputTokens: response.usage?.output_tokens ?? null,
    },
  };
}

export function createAnthropicClient(): Anthropic {
  // Credentials resolve from ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile.
  return new Anthropic({ maxRetries: 2 });
}
