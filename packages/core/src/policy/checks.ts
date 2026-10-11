import type { AgentPolicy, ConfidenceBreakdown, OrderDraft, PolicyReason, PolicyResult } from "@ai-erp/contracts";

export const POLICY_VERSION = "v1";

export interface PolicyThresholds {
  /** Minimum per-line match confidence to skip review. */
  lineAutoThreshold: number;
  /** Minimum overall confidence to skip review. */
  orderAutoThreshold: number;
}

export const DEFAULT_THRESHOLDS: PolicyThresholds = { lineAutoThreshold: 0.9, orderAutoThreshold: 0.95 };

export interface PolicyInput {
  draft: OrderDraft;
  confidence: ConfidenceBreakdown;
  agentPolicy: AgentPolicy | null;
  thresholds?: Partial<PolicyThresholds>;
}

const BLOCKING_ORDER_FLAGS = new Set(["no_lines", "customer_unresolved", "customer_inactive"]);
const REVIEW_LINE_FLAGS = new Set([
  "unmatched_product", "llm_abstained", "low_confidence_match", "uom_unknown", "uom_pack_mismatch",
  "qty_suspicious", "price_mismatch", "price_unknown",
]);
const REVIEW_ORDER_FLAGS = new Set(["customer_low_confidence", "duplicate_po", "ship_to_unresolved", "over_agent_value_cap"]);

/**
 * Deterministic, versioned policy. Blocks are structural problems a human must resolve;
 * reviews are proposals that may well be right but have not earned autonomy.
 */
export function evaluatePolicy(input: PolicyInput): PolicyResult {
  const t = { ...DEFAULT_THRESHOLDS, ...input.thresholds };
  const reasons: PolicyReason[] = [];
  const { draft, confidence } = input;

  for (const flag of draft.flags) {
    if (BLOCKING_ORDER_FLAGS.has(flag)) reasons.push({ code: flag, message: describe(flag), severity: "block" });
    else if (REVIEW_ORDER_FLAGS.has(flag)) reasons.push({ code: flag, message: describe(flag), severity: "review" });
  }
  for (const line of draft.lines) {
    for (const flag of line.flags) {
      if (REVIEW_LINE_FLAGS.has(flag)) {
        reasons.push({ code: flag, message: `line ${line.lineNo}: ${describe(flag)}`, severity: "review" });
      } else if (flag === "stock_short") {
        reasons.push({ code: flag, message: `line ${line.lineNo}: stock short`, severity: "info" });
      }
    }
    if (line.productId && line.matchConfidence < t.lineAutoThreshold) {
      reasons.push({ code: "line_below_threshold", message: `line ${line.lineNo}: match confidence ${line.matchConfidence.toFixed(2)} below ${t.lineAutoThreshold}`, severity: "review" });
    }
  }
  if (confidence.overall < t.orderAutoThreshold) {
    reasons.push({ code: "order_below_threshold", message: `overall confidence ${confidence.overall.toFixed(2)} below ${t.orderAutoThreshold}`, severity: "review" });
  }
  const cap = input.agentPolicy?.maxAutoOrderValue ?? null;
  if (cap !== null && draft.totals.subtotal > cap) {
    reasons.push({ code: "over_agent_value_cap", message: `order value ${draft.totals.subtotal} exceeds agent cap ${cap}`, severity: "review" });
  }

  const decision = reasons.some((r) => r.severity === "block")
    ? "block"
    : reasons.some((r) => r.severity === "review")
      ? "review"
      : "auto";
  return { decision, reasons: dedupe(reasons), policyVersion: POLICY_VERSION };
}

function dedupe(reasons: PolicyReason[]): PolicyReason[] {
  const seen = new Set<string>();
  return reasons.filter((r) => {
    const k = `${r.code}|${r.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function describe(flag: string): string {
  return flag.replace(/_/g, " ");
}
