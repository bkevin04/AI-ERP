import { createHash, randomUUID } from "node:crypto";

/** Deterministic JSON: sorted object keys, so hashes are stable across runs. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  if (value instanceof Date) return value.toISOString();
  return value;
}

export function sha256(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

export function hashJson(value: unknown): string {
  return sha256(stableStringify(value));
}

export function newId(): string {
  return randomUUID();
}

export function normalizeText(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** SKU normalisation: uppercase, strip everything but letters and digits. */
export function normalizeSku(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function emailDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  return email.slice(at + 1).toLowerCase().trim() || null;
}

/** Trigram similarity in the spirit of pg_trgm, used by the in-memory store and as a fallback. */
export function trigramSimilarity(a: string, b: string): number {
  const ta = trigrams(normalizeText(a));
  const tb = trigrams(normalizeText(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (const word of s.split(" ").filter(Boolean)) {
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
  }
  return out;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
