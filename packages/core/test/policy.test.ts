import { describe, expect, it } from "vitest";
import type { OrderDraft } from "@ai-erp/contracts";
import { computeConfidence, evaluatePolicy } from "../src/index.js";

function draft(overrides: Partial<OrderDraft> = {}, lineOverrides: Partial<OrderDraft["lines"][number]> = {}): OrderDraft {
  return {
    customerId: "11111111-1111-4111-8111-111111111111",
    customerMatch: { method: "contact_email", confidence: 0.95, candidates: [] },
    customerPoNumber: "PO-1", orderDate: null, requestedDate: null, shipTo: null, currency: "USD",
    lines: [{
      lineNo: 1, rawSku: "A", rawDescription: null, productId: "22222222-2222-4222-8222-222222222222", sku: "A", description: "A", qty: 2, uom: "EA", rawUom: null,
      statedUnitPrice: 10, expectedUnitPrice: 10, unitPrice: 10, lineTotal: 20, matchMethod: "sku_exact", matchConfidence: 0.95, candidates: [], flags: [], evidence: null,
      ...lineOverrides,
    }],
    totals: { subtotal: 20, lineCount: 1 }, flags: [], sourceDocumentIds: [],
    ...overrides,
  };
}

describe("confidence and policy", () => {
  it("clean draft is auto-eligible", () => {
    const d = draft();
    const c = computeConfidence(d);
    expect(c.overall).toBeCloseTo(0.95);
    expect(evaluatePolicy({ draft: d, confidence: c, agentPolicy: null }).decision).toBe("auto");
  });
  it("line flags demand review", () => {
    const d = draft({}, { flags: ["price_mismatch"] });
    const c = computeConfidence(d);
    const p = evaluatePolicy({ draft: d, confidence: c, agentPolicy: null });
    expect(p.decision).toBe("review");
    expect(p.reasons.map((r) => r.code)).toContain("price_mismatch");
  });
  it("unresolved customer blocks", () => {
    const d = draft({ customerId: null, customerMatch: { method: "unmatched", confidence: 0, candidates: [] }, flags: ["customer_unresolved"] });
    const c = computeConfidence(d);
    expect(c.overall).toBe(0);
    expect(evaluatePolicy({ draft: d, confidence: c, agentPolicy: null }).decision).toBe("block");
  });
  it("agent value cap sends to review", () => {
    const d = draft({ totals: { subtotal: 5000, lineCount: 1 } });
    const c = computeConfidence(d);
    const p = evaluatePolicy({ draft: d, confidence: c, agentPolicy: { principalId: "x", allowedTools: null, autoCommitEnabled: true, maxAutoOrderValue: 1000, rateLimitPerHour: null, killedAt: null } });
    expect(p.decision).toBe("review");
    expect(p.reasons.map((r) => r.code)).toContain("over_agent_value_cap");
  });
  it("thresholds are tunable", () => {
    const d = draft({}, { matchConfidence: 0.8, matchMethod: "llm_pick" });
    const c = computeConfidence(d);
    expect(evaluatePolicy({ draft: d, confidence: c, agentPolicy: null }).decision).toBe("review");
    expect(evaluatePolicy({ draft: d, confidence: c, agentPolicy: null, thresholds: { lineAutoThreshold: 0.7, orderAutoThreshold: 0.7 } }).decision).toBe("auto");
  });
});
