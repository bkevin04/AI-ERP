import { describe, expect, it } from "vitest";
import { RunKilledError, canTransition, createStepRunner } from "../src/index.js";
import { MemoryDb } from "../src/testing/index.js";

describe("step runner", () => {
  it("replays stored steps instead of re-executing", async () => {
    const db = new MemoryDb();
    const tenant = db.addTenant();
    const store = db.forTenant(tenant.id);
    let executions = 0;
    const body = async () => {
      const steps = createStepRunner({ store, runId: "run-1" });
      const a = await steps.step("a", "code", { x: 1 }, async () => { executions++; return "A"; });
      const b = await steps.step("b", "llm_call", { a }, async () => { executions++; return "B"; });
      return a + b;
    };
    expect(await body()).toBe("AB");
    expect(executions).toBe(2);
    expect(await body()).toBe("AB");
    expect(executions).toBe(2);
    expect(db.runSteps).toHaveLength(2);
  });

  it("stops at the next step when killed and records failed steps", async () => {
    const db = new MemoryDb();
    const tenant = db.addTenant();
    const store = db.forTenant(tenant.id);
    let kill = false;
    const steps = createStepRunner({ store, runId: "run-2", killCheck: async () => (kill ? "paused" : null) });
    await steps.step("a", "code", {}, async () => 1);
    kill = true;
    await expect(steps.step("b", "code", {}, async () => 2)).rejects.toBeInstanceOf(RunKilledError);
    kill = false;
    await expect(steps.step("c", "code", {}, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(db.runSteps.filter((s) => s.status === "error")).toHaveLength(1);
  });

  it("knows legal transitions", () => {
    expect(canTransition("queued", "running")).toBe(true);
    expect(canTransition("committed", "running")).toBe(false);
  });
});
