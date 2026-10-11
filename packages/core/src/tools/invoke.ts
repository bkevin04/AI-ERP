import { z } from "zod";
import type { PrincipalKind, Scope } from "@ai-erp/contracts";
import { ToolError } from "../errors.js";
import type { CoreStore, NewProvenanceEntry, PrincipalContext, TenantInfo } from "../store.js";
import { hashJson, newId } from "../util.js";
import type { ProvenanceChange, RunContext, ToolContext } from "./context.js";
import type { ToolDefinition, ToolRegistry } from "./define.js";

/** Scopes an agent principal can never exercise, whatever its roles say. */
export const AGENT_FORBIDDEN_SCOPES: ReadonlySet<Scope> = new Set<Scope>([
  "orders:approve",
  "orders:commit",
  "admin",
]);

export interface InvokeEnv {
  registry: ToolRegistry;
  store: CoreStore;
  tenant: TenantInfo;
  principal: PrincipalContext;
  run?: RunContext | null;
  now?: () => Date;
  /** Process-wide pause (env AGENTS_GLOBAL_PAUSE). Applies to agent principals only. */
  globalPause?: boolean;
}

export interface InvokeOptions {
  idempotencyKey?: string;
  sourceDocumentIds?: string[];
}

export interface InvokeResult<O> {
  output: O;
  /** True when the output came from a previous identical invocation. */
  replayed: boolean;
  stepId: string | null;
}

/**
 * The single choke point for every business operation.
 * UI, agent runtime and MCP clients all end up here.
 */
export async function invokeTool<O = unknown>(
  env: InvokeEnv,
  name: string,
  rawInput: unknown,
  opts: InvokeOptions = {},
): Promise<InvokeResult<O>> {
  const now = env.now ?? (() => new Date());
  const tool = env.registry.get(name);
  if (!tool) throw new ToolError("not_found", `unknown tool: ${name}`);

  assertPermitted(tool, env.principal);
  assertNotKilled(env, now());
  await assertUnderRateLimit(env, now());

  const parsedInput = tool.input.safeParse(rawInput);
  if (!parsedInput.success) {
    throw new ToolError("invalid_input", `invalid input for ${name}`, z.treeifyError(parsedInput.error));
  }
  const input = parsedInput.data;
  const requestHash = hashJson({ name, input });

  if (tool.idempotency === "required" && !opts.idempotencyKey) {
    throw new ToolError("idempotency_key_required", `${name} requires an idempotency key`);
  }

  if (opts.idempotencyKey) {
    const prior = await env.store.getIdempotentResult(env.principal.id, name, opts.idempotencyKey);
    if (prior) {
      if (prior.requestHash !== requestHash) {
        throw new ToolError("idempotency_conflict", `idempotency key reused with a different request`);
      }
      return { output: prior.result as O, replayed: true, stepId: null };
    }
  }

  return env.store.transaction(env.tenant.id, async (tx) => {
    const changes: ProvenanceChange[] = [];
    const sourceDocumentIds = opts.sourceDocumentIds ?? [];
    const ctx: ToolContext = {
      store: tx,
      tenant: env.tenant,
      principal: env.principal,
      run: env.run ?? null,
      now,
      sourceDocumentIds,
      recordChange: (c) => changes.push(c),
    };

    const started = Date.now();
    const output = await tool.handler(ctx, input);
    const parsedOutput = tool.output.safeParse(output);
    if (!parsedOutput.success) {
      throw new ToolError("invalid_output", `tool ${name} produced invalid output`, z.treeifyError(parsedOutput.error));
    }

    await tx.recordInvocation({ id: newId(), principalId: env.principal.id, tool: name, at: now() });

    let stepId: string | null = null;
    if (env.run) {
      const seq = env.run.nextSeq();
      stepId = newId();
      await tx.insertRunStep({
        id: stepId,
        runId: env.run.id,
        seq,
        kind: "tool_call",
        name,
        input,
        output: parsedOutput.data,
        idempotencyKey: hashJson({ runId: env.run.id, seq, name, input }),
        status: "ok",
        durationMs: Date.now() - started,
      });
    }

    // Side-effecting handlers record every state change; a handler that changed nothing
    // (a dedupe hit, for example) records nothing and leaves no provenance behind.
    if (tool.sideEffects !== "none" && changes.length > 0) {
      const entries: NewProvenanceEntry[] = changes.map((c) => ({
        id: newId(),
        entityType: c.entityType,
        entityId: c.entityId,
        entityVersion: c.entityVersion ?? null,
        action: c.action,
        runId: env.run?.id ?? null,
        stepId,
        proposalId: c.proposalId ?? null,
        approvalId: c.approvalId ?? null,
        policyVersion: c.policyVersion ?? null,
        promptVersion: c.promptVersion ?? null,
        modelId: c.modelId ?? null,
        sourceDocumentIds: c.sourceDocumentIds ?? sourceDocumentIds,
        actorPrincipalId: env.principal.id,
        diff: c.diff ?? null,
      }));
      await tx.insertProvenance(entries);
    }

    if (opts.idempotencyKey) {
      await tx.saveIdempotentResult({
        principalId: env.principal.id,
        tool: name,
        key: opts.idempotencyKey,
        requestHash,
        result: parsedOutput.data,
      });
    }

    return { output: parsedOutput.data as O, replayed: false, stepId };
  });
}

function assertPermitted(tool: ToolDefinition, principal: PrincipalContext): void {
  const isAgent: boolean = principal.kind === ("agent" satisfies PrincipalKind);
  if (isAgent && AGENT_FORBIDDEN_SCOPES.has(tool.scope)) {
    throw new ToolError("forbidden", `agents may never use ${tool.scope}`);
  }
  if (!principal.scopes.has(tool.scope) && !principal.scopes.has("admin")) {
    throw new ToolError("forbidden", `missing scope ${tool.scope} for ${tool.name}`);
  }
  if (isAgent) {
    const policy = principal.policy;
    if (!policy) throw new ToolError("forbidden", `agent ${principal.id} has no policy`);
    if (policy.allowedTools !== null && !policy.allowedTools.includes(tool.name)) {
      throw new ToolError("forbidden", `tool ${tool.name} not in agent's allowed tools`);
    }
  }
}

function assertNotKilled(env: InvokeEnv, at: Date): void {
  if (env.principal.kind !== "agent") return;
  if (env.globalPause) throw new ToolError("killed", "all agents are paused (global)");
  if (env.tenant.agentsPausedAt && env.tenant.agentsPausedAt <= at) {
    throw new ToolError("killed", "agents are paused for this tenant");
  }
  const killedAt = env.principal.policy?.killedAt ?? null;
  if (killedAt && killedAt <= at) throw new ToolError("killed", `agent ${env.principal.id} is killed`);
}

async function assertUnderRateLimit(env: InvokeEnv, at: Date): Promise<void> {
  const limit = env.principal.policy?.rateLimitPerHour ?? null;
  if (limit === null) return;
  const since = new Date(at.getTime() - 60 * 60 * 1000);
  const count = await env.store.countInvocationsSince(env.principal.id, since);
  if (count >= limit) throw new ToolError("rate_limited", `agent exceeded ${limit} invocations per hour`);
}
