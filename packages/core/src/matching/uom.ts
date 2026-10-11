/** Unit-of-measure synonyms → canonical codes. Extend per tenant later via rules. */
const UOM_SYNONYMS: Record<string, string> = {
  ea: "EA", each: "EA", pc: "EA", pcs: "EA", piece: "EA", pieces: "EA", unit: "EA", units: "EA", stk: "EA", st: "EA",
  cs: "CS", case: "CS", cases: "CS", ctn: "CS", carton: "CS", cartons: "CS",
  bx: "BX", box: "BX", boxes: "BX",
  pk: "PK", pack: "PK", packs: "PK", pkg: "PK",
  dz: "DZ", doz: "DZ", dozen: "DZ",
  pl: "PL", plt: "PL", pallet: "PL", pallets: "PL",
  kg: "KG", kgs: "KG", kilogram: "KG", kilograms: "KG",
  g: "G", gram: "G", grams: "G",
  lb: "LB", lbs: "LB", pound: "LB", pounds: "LB",
  l: "L", ltr: "L", liter: "L", litre: "L", liters: "L", litres: "L",
  ml: "ML",
  m: "M", mtr: "M", meter: "M", metre: "M", meters: "M", metres: "M",
  roll: "RL", rolls: "RL", rl: "RL",
  bag: "BG", bags: "BG", bg: "BG",
  pr: "PR", pair: "PR", pairs: "PR",
  set: "SET", sets: "SET",
};

/** Units where fractional quantities are suspicious. */
const DISCRETE_UOMS = new Set(["EA", "CS", "BX", "PK", "DZ", "PL", "RL", "BG", "PR", "SET"]);

export function normalizeUom(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase().replace(/[.\s]+$/g, "").replace(/\s+/g, "");
  if (!key) return null;
  return UOM_SYNONYMS[key] ?? (key.length <= 4 ? key.toUpperCase() : null);
}

export function isDiscreteUom(uom: string): boolean {
  return DISCRETE_UOMS.has(uom);
}

export interface UomResolution {
  uom: string;
  qty: number;
  flags: Array<"uom_unknown" | "uom_pack_mismatch" | "qty_suspicious">;
}

/**
 * Decide the unit the order line is placed in. If the document's unit is a pack the
 * product knows about, keep it (ERPs accept per-line units). Otherwise fall back to the
 * product's base unit and flag what was ambiguous.
 */
export function resolveLineUom(
  rawUom: string | null,
  qty: number,
  product: { baseUom: string; packFactors: Record<string, number> },
): UomResolution {
  const flags: UomResolution["flags"] = [];
  const canonical = normalizeUom(rawUom);
  let uom = product.baseUom;

  if (rawUom && canonical === null) {
    flags.push("uom_unknown");
  } else if (canonical && canonical !== product.baseUom) {
    if (product.packFactors[canonical] !== undefined) {
      uom = canonical;
    } else {
      flags.push("uom_pack_mismatch");
    }
  }

  if (!(qty > 0) || (isDiscreteUom(uom) && !Number.isInteger(qty))) {
    flags.push("qty_suspicious");
  }
  return { uom, qty, flags };
}
