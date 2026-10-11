import { describe, expect, it } from "vitest";
import type { OrderDraft } from "@ai-erp/contracts";
import { aggregate, computeGate, scoreCase } from "../src/index.js";

const line = (productId: string | null, qty: number, unitPrice = 1): OrderDraft["lines"][number] => ({
  lineNo: 1, rawSku: null, rawDescription: null, productId, sku: null, description: "", qty, uom: "EA", rawUom: null,
  statedUnitPrice: null, expectedUnitPrice: unitPrice, unitPrice, lineTotal: qty * unitPrice, matchMethod: productId ? "sku_exact" : "unmatched",
  matchConfidence: productId ? 0.95 : 0, candidates: [], flags: [], evidence: null,
});
const draft = (lines: OrderDraft["lines"], customerId: string | null = "c1"): OrderDraft => ({
  customerId, customerMatch: { method: "contact_email", confidence: 0.95, candidates: [] }, customerPoNumber: "PO-1", orderDate: null, requestedDate: null,
  shipTo: null, currency: "USD", lines, totals: { subtotal: 0, lineCount: lines.length }, flags: [], sourceDocumentIds: [],
});
const truth = { customerId: "c1", customerPoNumber: "PO-1", requestedDate: null, lines: [{ productId: "p1", qty: 2, uom: "EA", unitPrice: 1 }, { productId: "p2", qty: 5, uom: "EA", unitPrice: 1 }] };

describe("scoreCase", () => {
  it("exact match scores perfectly", () => {
    const s = scoreCase(draft([line("p1", 2), line("p2", 5)]), truth);
    expect(s.orderExact).toBe(true);
    expect(s.lines.full).toEqual({ precision: 1, recall: 1, f1: 1 });
    expect(s.criticalErrors).toBe(0);
  });
  it("wrong quantity is a critical error at the qty level but not the product level", () => {
    const s = scoreCase(draft([line("p1", 3), line("p2", 5)]), truth);
    expect(s.lines.product.f1).toBe(1);
    expect(s.lines.productQty.recall).toBe(0.5);
    expect(s.orderExact).toBe(false);
    expect(s.criticalErrors).toBeGreaterThan(0);
  });
  it("missing and extra lines reduce recall and precision respectively", () => {
    expect(scoreCase(draft([line("p1", 2)]), truth).lines.product.recall).toBe(0.5);
    expect(scoreCase(draft([line("p1", 2), line("p2", 5), line("p3", 1)]), truth).lines.product.precision).toBeCloseTo(2 / 3);
  });
  it("wrong customer is critical", () => {
    expect(scoreCase(draft([line("p1", 2), line("p2", 5)], "other"), truth).criticalErrors).toBe(1);
  });
});

describe("gate", () => {
  it("stays red until enough perfect auto-eligible cases exist", () => {
    const perfect = scoreCase(draft([line("p1", 2), line("p2", 5)]), truth);
    const few = aggregate(Array.from({ length: 10 }, () => ({ score: perfect, decision: "auto" as const })));
    expect(computeGate(few).green).toBe(false);
    const enough = aggregate(Array.from({ length: 60 }, () => ({ score: perfect, decision: "auto" as const })));
    expect(computeGate(enough).green).toBe(true);
    const wrong = scoreCase(draft([line("p1", 3), line("p2", 5)]), truth);
    const oneBad = aggregate([...Array.from({ length: 59 }, () => ({ score: perfect, decision: "auto" as const })), { score: wrong, decision: "auto" as const }]);
    expect(computeGate(oneBad).green).toBe(false);
    expect(oneBad.autoEligiblePrecision).toBeCloseTo(59 / 60);
  });
  it("counts review load", () => {
    const perfect = scoreCase(draft([line("p1", 2), line("p2", 5)]), truth);
    expect(aggregate([{ score: perfect, decision: "review" }]).reviewLoad).toBe(1);
  });
});
