import type { LineFlag, ProductCandidate } from "@ai-erp/contracts";
import type { CoreStore, ProductSummary } from "../store.js";
import { normalizeSku, normalizeText } from "../util.js";
import { resolveLineUom } from "./uom.js";

export interface ProductLineInput {
  customerId: string | null;
  rawSku: string | null;
  rawDescription: string | null;
  qty: number;
  rawUom: string | null;
}

export interface ProductLineMatch {
  best: ProductCandidate | null;
  candidates: ProductCandidate[];
  product: ProductSummary | null;
  qty: number;
  uom: string;
  flags: LineFlag[];
}

const toCandidate = (p: ProductSummary, score: number, method: ProductCandidate["method"]): ProductCandidate => ({
  productId: p.id,
  sku: p.sku,
  name: p.name,
  score,
  method,
});

/**
 * Deterministic product cascade. Returns `best: null` with ranked candidates when only
 * fuzzy search matched, so the pipeline can ask the model to pick or abstain.
 */
export async function matchProductLine(store: CoreStore, input: ProductLineInput): Promise<ProductLineMatch> {
  const decisive = await findDecisive(store, input);
  if (decisive) return finish(decisive.product, decisive.candidate, [decisive.candidate], input);

  const text = [input.rawSku, input.rawDescription].filter(Boolean).join(" ");
  const candidates: ProductCandidate[] = [];
  if (text.trim()) {
    const hits = await store.searchProducts(text, 5);
    candidates.push(...hits.map((h) => toCandidate(h.product, Math.min(0.8, Math.max(0.6, h.score)), "search")));
  }
  return finish(null, null, candidates, input);
}

async function findDecisive(
  store: CoreStore,
  input: ProductLineInput,
): Promise<{ product: ProductSummary; candidate: ProductCandidate } | null> {
  const aliasKeys = [input.rawSku, input.rawDescription].filter((s): s is string => !!s && s.trim().length > 0);

  // 1. customer-specific alias (what the reviewer taught us for this customer)
  if (input.customerId) {
    for (const key of aliasKeys) {
      const hits = await store.findProductAliases(normalizeText(key), input.customerId);
      const mine = hits.filter((h) => h.alias.customerId === input.customerId);
      if (mine.length === 1) return { product: mine[0]!.product, candidate: toCandidate(mine[0]!.product, 0.98, "customer_alias") };
    }
  }
  // 2. normalised SKU
  if (input.rawSku) {
    const p = await store.findProductBySku(normalizeSku(input.rawSku));
    if (p) return { product: p, candidate: toCandidate(p, 0.95, "sku_exact") };
    // 3. barcode (SKU column often carries EAN/UPC)
    if (/^\d{8,14}$/.test(input.rawSku.trim())) {
      const b = await store.findProductByBarcode(input.rawSku.trim());
      if (b) return { product: b, candidate: toCandidate(b, 0.95, "barcode") };
    }
  }
  // 4. tenant-wide alias
  for (const key of aliasKeys) {
    const hits = await store.findProductAliases(normalizeText(key), null);
    const tenantWide = hits.filter((h) => h.alias.customerId === null);
    if (tenantWide.length === 1) return { product: tenantWide[0]!.product, candidate: toCandidate(tenantWide[0]!.product, 0.9, "tenant_alias") };
  }
  return null;
}

function finish(
  product: ProductSummary | null,
  best: ProductCandidate | null,
  candidates: ProductCandidate[],
  input: ProductLineInput,
): ProductLineMatch {
  const flags: LineFlag[] = [];
  if (!product) {
    flags.push("unmatched_product");
    return { best, candidates, product, qty: input.qty, uom: input.rawUom ?? "EA", flags };
  }
  const uom = resolveLineUom(input.rawUom, input.qty, product);
  flags.push(...uom.flags);
  if (best && best.score < 0.9) flags.push("low_confidence_match");
  return { best, candidates, product, qty: uom.qty, uom: uom.uom, flags };
}

/** Apply a model's pick to an ambiguous line. */
export function applyPick(
  match: ProductLineMatch,
  pick: { productId: string; product: ProductSummary } | null,
  input: ProductLineInput,
): ProductLineMatch {
  if (!pick) {
    return { ...match, flags: dedupeFlags([...match.flags, "llm_abstained"]) };
  }
  const chosen = match.candidates.find((c) => c.productId === pick.productId);
  const candidate: ProductCandidate = {
    productId: pick.productId,
    sku: pick.product.sku,
    name: pick.product.name,
    score: Math.min(0.8, Math.max(0.6, chosen?.score ?? 0.6)),
    method: "llm_pick",
  };
  return finish(pick.product, candidate, match.candidates, input);
}

function dedupeFlags(flags: LineFlag[]): LineFlag[] {
  return [...new Set(flags)];
}
