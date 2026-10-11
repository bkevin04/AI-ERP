import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolError, ToolRegistry, defineTool, invokeTool, type InvokeEnv } from "../src/index.js";
import { MemoryDb } from "../src/testing/index.js";

function setup() {
  const db = new MemoryDb();
  const tenant = db.addTenant();
  const registry = new ToolRegistry();
  let executions = 0;
  registry.register(
    defineTool({
      name: "echo", description: "echo", scope: "customers:read", sideEffects: "none", exposure: ["http"],
      input: z.object({ msg: z.string() }), output: z.object({ msg: z.string() }),
      handler: async (_ctx, i) => { executions++; return { msg: i.msg }; },
    }),
  );
  registry.register(
    defineTool({
      name: "write_thing", description: "writes", scope: "orders:propose", sideEffects: "write", exposure: ["http"], idempotency: "required",
      input: z.object({ v: z.number() }), output: z.object({ ok: z.boolean() }),
      handler: async (ctx, i) => {
        executions++;
        ctx.recordChange({ entityType: "thing", entityId: "t1", entityVersion: 1, action: "thing.created", proposalId: null, approvalId: null, policyVersion: null, promptVersion: null, modelId: null, diff: { v: i.v } });
        return { ok: true };
      },
    }),
  );
  registry.register(
    defineTool({
      name: "approve_thing", description: "approves", scope: "orders:approve", sideEffects: "write", exposure: ["http"],
      input: z.object({}), output: z.object({ ok: z.boolean() }), handler: async () => ({ ok: true }),
    }),
  );
  const env = (principalScopes: string[], kind: "human" | "agent" = "human", policy?: Parameters<MemoryDb["addPrincipal"]>[0]["policy"], extra: Partial<InvokeEnv> = {}): InvokeEnv => ({
    registry, store: db.forTenant(tenant.id), tenant,
    principal: db.addPrincipal({ tenantId: tenant.id, kind, scopes: principalScopes, policy }),
    ...extra,
  });
  return { db, tenant, registry, env, executions: () => executions };
}

describe("invokeTool", () => {
  it("runs a tool for a principal with the scope", async () => {
    const s = setup();
    const r = await invokeTool<{ msg: string }>(s.env(["customers:read"]), "echo", { msg: "hi" });
    expect(r.output.msg).toBe("hi");
    expect(r.replayed).toBe(false);
  });

  it("rejects a missing scope and unknown tools", async () => {
    const s = setup();
    await expect(invokeTool(s.env([]), "echo", { msg: "hi" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(invokeTool(s.env(["admin"]), "nope", {})).rejects.toMatchObject({ code: "not_found" });
  });

  it("admin scope satisfies any tool scope for humans", async () => {
    const s = setup();
    await expect(invokeTool(s.env(["admin"]), "echo", { msg: "x" })).resolves.toBeTruthy();
  });

  it("never lets an agent approve, even with the scope granted", async () => {
    const s = setup();
    await expect(invokeTool(s.env(["orders:approve"], "agent"), "approve_thing", {})).rejects.toMatchObject({ code: "forbidden" });
  });

  it("enforces the agent's allowed tool list", async () => {
    const s = setup();
    await expect(invokeTool(s.env(["customers:read"], "agent", { allowedTools: ["other"] }), "echo", { msg: "x" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(invokeTool(s.env(["customers:read"], "agent", { allowedTools: ["echo"] }), "echo", { msg: "x" })).resolves.toBeTruthy();
  });

  it("kill switch stops agents at tenant, agent and global level but not humans", async () => {
    const s = setup();
    const paused = { ...s.tenant, agentsPausedAt: new Date(Date.now() - 1000) };
    await expect(invokeTool({ ...s.env(["customers:read"], "agent"), tenant: paused }, "echo", { msg: "x" })).rejects.toMatchObject({ code: "killed" });
    await expect(invokeTool({ ...s.env(["customers:read"]), tenant: paused }, "echo", { msg: "x" })).resolves.toBeTruthy();
    await expect(invokeTool(s.env(["customers:read"], "agent", { killedAt: new Date(0) }), "echo", { msg: "x" })).rejects.toMatchObject({ code: "killed" });
    await expect(invokeTool({ ...s.env(["customers:read"], "agent"), globalPause: true }, "echo", { msg: "x" })).rejects.toMatchObject({ code: "killed" });
  });

  it("rate limits agents per hour", async () => {
    const s = setup();
    const env = s.env(["customers:read"], "agent", { rateLimitPerHour: 2 });
    await invokeTool(env, "echo", { msg: "1" });
    await invokeTool(env, "echo", { msg: "2" });
    await expect(invokeTool(env, "echo", { msg: "3" })).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("validates input", async () => {
    const s = setup();
    await expect(invokeTool(s.env(["customers:read"]), "echo", { msg: 1 })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("requires and honours idempotency keys", async () => {
    const s = setup();
    const env = s.env(["orders:propose"]);
    await expect(invokeTool(env, "write_thing", { v: 1 })).rejects.toMatchObject({ code: "idempotency_key_required" });
    const first = await invokeTool(env, "write_thing", { v: 1 }, { idempotencyKey: "k1" });
    const again = await invokeTool(env, "write_thing", { v: 1 }, { idempotencyKey: "k1" });
    expect(first.replayed).toBe(false);
    expect(again.replayed).toBe(true);
    expect(s.executions()).toBe(1);
    await expect(invokeTool(env, "write_thing", { v: 2 }, { idempotencyKey: "k1" })).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("writes provenance for side-effecting tools and run steps inside a run", async () => {
    const s = setup();
    let seq = 0;
    const env = { ...s.env(["orders:propose"]), run: { id: "run-1", nextSeq: () => ++seq } };
    const r = await invokeTool(env, "write_thing", { v: 7 }, { idempotencyKey: "k", sourceDocumentIds: ["doc-1"] });
    expect(r.stepId).not.toBeNull();
    expect(s.db.provenance).toHaveLength(1);
    expect(s.db.provenance[0]).toMatchObject({ entityType: "thing", action: "thing.created", runId: "run-1", stepId: r.stepId, actorPrincipalId: env.principal.id, sourceDocumentIds: ["doc-1"] });
    expect(s.db.runSteps).toHaveLength(1);
    expect(s.db.runSteps[0]).toMatchObject({ runId: "run-1", seq: 1, name: "write_thing", kind: "tool_call", status: "ok" });
  });

  it("a side-effecting tool that records no change leaves no provenance", async () => {
    const s = setup();
    s.registry.register(defineTool({
      name: "noop_write", description: "", scope: "orders:propose", sideEffects: "write", exposure: ["http"],
      input: z.object({}), output: z.object({ ok: z.boolean() }), handler: async () => ({ ok: true }),
    }));
    await invokeTool(s.env(["orders:propose"]), "noop_write", {});
    expect(s.db.provenance).toHaveLength(0);
  });

  it("read-only tools write no provenance", async () => {
    const s = setup();
    await invokeTool(s.env(["customers:read"]), "echo", { msg: "x" });
    expect(s.db.provenance).toHaveLength(0);
  });

  it("ToolError maps to http statuses", () => {
    expect(new ToolError("forbidden", "x").httpStatus).toBe(403);
    expect(new ToolError("rate_limited", "x").httpStatus).toBe(429);
    expect(new ToolError("invalid_input", "x").httpStatus).toBe(400);
  });
});
