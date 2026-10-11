import type { CustomerCandidate } from "@ai-erp/contracts";
import type { CoreStore, CustomerSummary } from "../store.js";
import { emailDomain, normalizeText } from "../util.js";

export interface CustomerHints {
  email?: string | null;
  senderEmail?: string | null;
  name?: string | null;
  postalCode?: string | null;
  poNumber?: string | null;
  accountNumber?: string | null;
}

export interface CustomerMatch {
  best: CustomerCandidate | null;
  candidates: CustomerCandidate[];
}

const toCandidate = (c: CustomerSummary, score: number, method: CustomerCandidate["method"]): CustomerCandidate => ({
  customerId: c.id,
  name: c.name,
  score,
  method,
});

/**
 * Deterministic cascade; first decisive hit wins. Ambiguous hits are returned as
 * candidates with `best: null` so the pipeline can ask the model to disambiguate.
 */
export async function matchCustomer(store: CoreStore, hints: CustomerHints): Promise<CustomerMatch> {
  const candidates: CustomerCandidate[] = [];

  for (const email of [hints.email, hints.senderEmail]) {
    if (!email) continue;
    const byContact = await store.findCustomersByContactEmail(email.toLowerCase().trim());
    if (byContact.length === 1) {
      const c = toCandidate(byContact[0]!, 0.95, "contact_email");
      return { best: c, candidates: [c] };
    }
    candidates.push(...byContact.map((c) => toCandidate(c, 0.6, "contact_email")));
  }

  for (const email of [hints.email, hints.senderEmail]) {
    const domain = emailDomain(email);
    if (!domain || isFreemailDomain(domain)) continue;
    const byDomain = await store.findCustomersByDomain(domain);
    if (byDomain.length === 1) {
      const c = toCandidate(byDomain[0]!, 0.85, "sender_domain");
      return { best: c, candidates: dedupe([c, ...candidates]) };
    }
    candidates.push(...byDomain.map((c) => toCandidate(c, 0.6, "sender_domain")));
  }

  if (hints.name) {
    const hits = await store.searchCustomersByName(hints.name, 5);
    const strong = hits.filter((h) => h.similarity >= 0.6);
    if (strong.length === 1 && hints.postalCode && strong[0]!.customer.billingPostalCode) {
      const sameZip = normalizeText(strong[0]!.customer.billingPostalCode) === normalizeText(hints.postalCode);
      if (sameZip) {
        const c = toCandidate(strong[0]!.customer, 0.7, "name_postal");
        return { best: c, candidates: dedupe([c, ...candidates]) };
      }
    }
    if (strong.length === 1 && strong[0]!.similarity >= 0.9) {
      const c = toCandidate(strong[0]!.customer, 0.7, "name_postal");
      return { best: c, candidates: dedupe([c, ...candidates]) };
    }
    candidates.push(...hits.map((h) => toCandidate(h.customer, Math.min(0.65, h.similarity), "name_postal")));
  }

  if (hints.poNumber && hints.poNumber.length >= 4) {
    const prefix = hints.poNumber.replace(/[0-9]+$/, "");
    if (prefix.length >= 2) {
      const byPrefix = await store.findCustomersByPoPrefix(prefix);
      if (byPrefix.length === 1) {
        const c = toCandidate(byPrefix[0]!, 0.65, "po_prefix");
        return { best: c, candidates: dedupe([c, ...candidates]) };
      }
      candidates.push(...byPrefix.map((c) => toCandidate(c, 0.5, "po_prefix")));
    }
  }

  return { best: null, candidates: dedupe(candidates).slice(0, 5) };
}

function dedupe(list: CustomerCandidate[]): CustomerCandidate[] {
  const seen = new Map<string, CustomerCandidate>();
  for (const c of list) {
    const prev = seen.get(c.customerId);
    if (!prev || prev.score < c.score) seen.set(c.customerId, c);
  }
  return [...seen.values()].sort((a, b) => b.score - a.score);
}

const FREEMAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "hotmail.com", "outlook.com", "live.com",
  "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com", "gmx.de", "gmx.net", "web.de", "mail.com",
]);

export function isFreemailDomain(domain: string): boolean {
  return FREEMAIL.has(domain.toLowerCase());
}
