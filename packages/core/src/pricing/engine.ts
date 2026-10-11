import type { CoreStore, PriceResolution } from "../store.js";

export interface PriceCheck {
  expectedUnitPrice: number | null;
  unitPrice: number | null;
  source: PriceResolution["source"] | null;
  flags: Array<"price_mismatch" | "price_unknown">;
}

export interface PricingOptions {
  /** Relative tolerance before a stated price is flagged, e.g. 0.02 = 2%. */
  tolerance: number;
}

export const DEFAULT_PRICING: PricingOptions = { tolerance: 0.02 };

/**
 * Our price list always wins. A stated price inside tolerance is silently replaced with
 * ours; outside tolerance it is flagged for a human. A customer's price is never accepted
 * without review.
 */
export async function priceLine(
  store: CoreStore,
  args: { customerId: string | null; productId: string; qty: number; statedUnitPrice: number | null },
  opts: PricingOptions = DEFAULT_PRICING,
): Promise<PriceCheck> {
  const resolved = await store.resolvePrice(args.customerId, args.productId, args.qty);
  if (!resolved) {
    return { expectedUnitPrice: null, unitPrice: args.statedUnitPrice, source: null, flags: ["price_unknown"] };
  }
  const flags: PriceCheck["flags"] = [];
  if (args.statedUnitPrice !== null && !withinTolerance(args.statedUnitPrice, resolved.unitPrice, opts.tolerance)) {
    flags.push("price_mismatch");
  }
  return { expectedUnitPrice: resolved.unitPrice, unitPrice: resolved.unitPrice, source: resolved.source, flags };
}

export function withinTolerance(stated: number, expected: number, tolerance: number): boolean {
  if (expected === 0) return stated === 0;
  return Math.abs(stated - expected) / Math.abs(expected) <= tolerance;
}
