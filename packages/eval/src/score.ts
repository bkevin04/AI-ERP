import { z } from "zod";
import type { OrderDraft, PolicyDecision } from "@ai-erp/contracts";

export const GroundTruthLine = z.object({
  productId: z.string(),
  qty: z.number(),
  uom: z.string(),
  unitPrice: z.number().nullable(),
});

export const GroundTruthOrder = z.object({
  customerId: z.string().nullable(),
  customerPoNumber: z.string().nullable(),
  requestedDate: z.string().nullable(),
  lines: z.array(GroundTruthLine),
});
export type GroundTruthOrder = z.infer<typeof GroundTruthOrder>;

export interface LineScores {
  precision: number;
  recall: number;
  f1: number;
}

export interface CaseScore {
  header: { customer: boolean; customerPoNumber: boolean; requestedDate: boolean };
  lines: { product: LineScores; productQty: LineScores; full: LineScores };
  orderExact: boolean;
  /** Customer, product or quantity wrong: the errors that cost real money. */
  criticalErrors: number;
}

type Level = "product" | "productQty" | "full";

function lineKey(level: Level, l: { productId: string | null; qty: number; uom: string; unitPrice: number | null }): string | null {
  if (!l.productId) return null;
  if (level === "product") return l.productId;
  if (level === "productQty") return `${l.productId}|${l.qty}`;
  return `${l.productId}|${l.qty}|${l.uom}|${l.unitPrice ?? "null"}`;
}

function prf(level: Level, pred: OrderDraft["lines"], truth: GroundTruthOrder["lines"]): LineScores {
  const truthKeys = truth.map((l) => lineKey(level, l));
  const used = new Set<number>();
  let matched = 0;
  for (const p of pred) {
    const k = lineKey(level, p);
    if (k === null) continue;
    const idx = truthKeys.findIndex((t, i) => t === k && !used.has(i));
    if (idx >= 0) { used.add(idx); matched++; }
  }
  const precision = pred.length === 0 ? (truth.length === 0 ? 1 : 0) : matched / pred.length;
  const recall = truth.length === 0 ? (pred.length === 0 ? 1 : 0) : matched / truth.length;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

export function scoreCase(pred: OrderDraft, truth: GroundTruthOrder): CaseScore {
  const header = {
    customer: pred.customerId === truth.customerId,
    customerPoNumber: (pred.customerPoNumber ?? null) === (truth.customerPoNumber ?? null),
    requestedDate: (pred.requestedDate ?? null) === (truth.requestedDate ?? null),
  };
  const lines = { product: prf("product", pred.lines, truth.lines), productQty: prf("productQty", pred.lines, truth.lines), full: prf("full", pred.lines, truth.lines) };
  const orderExact = header.customer && header.customerPoNumber && lines.full.precision === 1 && lines.full.recall === 1 && pred.lines.length === truth.lines.length;
  const criticalErrors = (header.customer ? 0 : 1) + Math.max(0, truth.lines.length - Math.round(lines.productQty.recall * truth.lines.length)) + Math.max(0, pred.lines.length - Math.round(lines.productQty.precision * pred.lines.length));
  return { header, lines, orderExact, criticalErrors };
}

export interface AggregateScores {
  n: number;
  headerAccuracy: { customer: number; customerPoNumber: number; requestedDate: number };
  lineF1: { product: number; productQty: number; full: number };
  orderExactRate: number;
  /** Among cases the policy would have auto-committed, the fraction that exactly match truth. */
  autoEligiblePrecision: number | null;
  autoEligibleCount: number;
  /** Cases that were exactly right but sent to review anyway. */
  reviewLoad: number;
  criticalErrors: number;
}

export function aggregate(items: Array<{ score: CaseScore; decision: PolicyDecision }>): AggregateScores {
  const n = items.length;
  const mean = (f: (s: CaseScore) => number) => (n === 0 ? 0 : items.reduce((a, i) => a + f(i.score), 0) / n);
  const auto = items.filter((i) => i.decision === "auto");
  const autoExact = auto.filter((i) => i.score.orderExact).length;
  return {
    n,
    headerAccuracy: { customer: mean((s) => +s.header.customer), customerPoNumber: mean((s) => +s.header.customerPoNumber), requestedDate: mean((s) => +s.header.requestedDate) },
    lineF1: { product: mean((s) => s.lines.product.f1), productQty: mean((s) => s.lines.productQty.f1), full: mean((s) => s.lines.full.f1) },
    orderExactRate: mean((s) => +s.orderExact),
    autoEligiblePrecision: auto.length === 0 ? null : autoExact / auto.length,
    autoEligibleCount: auto.length,
    reviewLoad: items.filter((i) => i.decision !== "auto" && i.score.orderExact).length,
    criticalErrors: items.reduce((a, i) => a + i.score.criticalErrors, 0),
  };
}
