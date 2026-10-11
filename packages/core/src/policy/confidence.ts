import type { ConfidenceBreakdown, OrderDraft } from "@ai-erp/contracts";
import { clamp01 } from "../util.js";

/** Penalties are deterministic and documented; the model's self-confidence never enters here. */
export const FLAG_PENALTIES: Record<string, number> = {
  unmatched_product: 0.5,
  llm_abstained: 0.3,
  low_confidence_match: 0.1,
  uom_unknown: 0.2,
  uom_pack_mismatch: 0.15,
  qty_suspicious: 0.2,
  price_mismatch: 0.15,
  price_unknown: 0.1,
  stock_short: 0.05,
  customer_low_confidence: 0.1,
  customer_inactive: 0.5,
  duplicate_po: 0.3,
  ship_to_unresolved: 0.05,
  no_lines: 1,
  customer_unresolved: 1,
};

export function computeConfidence(draft: OrderDraft): ConfidenceBreakdown {
  const customer = draft.customerId ? draft.customerMatch.confidence : 0;
  const linesMin = draft.lines.length === 0 ? 0 : Math.min(...draft.lines.map((l) => l.matchConfidence));
  const seen = new Set<string>();
  const penalties: ConfidenceBreakdown["penalties"] = [];
  for (const flag of [...draft.flags, ...draft.lines.flatMap((l) => l.flags)]) {
    if (seen.has(flag)) continue;
    seen.add(flag);
    const penalty = FLAG_PENALTIES[flag] ?? 0.05;
    penalties.push({ flag, penalty });
  }
  const base = Math.min(customer, linesMin);
  const overall = clamp01(base - penalties.reduce((s, p) => s + p.penalty, 0));
  return { customer, linesMin, penalties, overall };
}
