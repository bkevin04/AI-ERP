# Roadmap

Solo builder. Each week ends demoable. Outreach runs alongside the build from week one.

| Week | Build | Demoable outcome | Go-to-market |
|---|---|---|---|
| 1 | Monorepo, Drizzle schema with RLS and append-only triggers, `defineTool` and `invokeTool`, HTTP and MCP adapters, Odoo compose plus seed, Odoo pull sync. Strategy and architecture docs in the repo. | Master data synced from Odoo; `find_customer` called from curl and from an MCP client. | Apollo lists for A, B, C; outreach email and interview script; first 50 emails. |
| 2 | Upload endpoint and Postmark webhook, documents and events, pg-boss worker, run state machine with step replay, triage and extraction with structured outputs. | Drop a PDF PO, watch the run trace and extracted JSON appear. | 50 more emails; post in two communities. |
| 3 | Matching cascades, units, pricing engine, stock, proposals, confidence, policy checks v1, provenance writes, eval CLI v0 on 20 synthetic cases. | Email becomes a proposal with per-line confidence and flags; first precision and recall numbers. | Record the demo video; use it in all outreach. |
| 4 | Review queue and detail view with document viewer, approve, edit, reject, corrections to aliases and rules, "explain this", magic-link auth, API keys. | Reviewer fixes a line once; the next PO from that customer matches automatically. | First interviews; collect sample documents. |
| 5 | Commit, outbox write-back to Odoo, search-before-create, reconcile job, dry-run connector, kill switch, autonomy levels, audit timeline. | Email to sales order visible in Odoo with a full provenance timeline. | Interviews continue; segment decision by end of week. |
| 6 | Cases from approvals, full scorer, autonomy gate, 100-case synthetic set plus real samples, retry and dedupe hardening, seeded demo tenant. | Ten mixed inputs: some auto-commit, some to review; eval dashboard flips the gate green. | Pilot offers to the three best-fit companies. |
| 7 | Agent recipes as data, agent principals with scopes, recipes two and three shipped, tenant isolation tests (two tenants, zero cross-reads). | The same platform runs three different agents with the same approvals and audit. | Landing page and waitlist live. |
| 8 | First pilot onboarding: CSV import, inbox address, Odoo or QuickBooks connector as the pilot needs; weekly metrics view. | Pilot running on real documents with before and after minutes per order. | Tailor to the chosen segment. |

## Explicitly out of the MVP

General ledger, invoicing and tax, payroll, BOMs and routing, purchasing automation, EDI, mobile, SSO, multi-currency, vector search, Temporal, the visual agent-builder UI (recipes are edited as data until three recipes are proven).

## Verification

- End-to-end demo: an email with a PDF arrives, a proposal appears with confidences and evidence highlights, approve, the order exists in Odoo, the provenance ledger reproduces the whole chain.
- Eval harness: field and line scores per document type tracked per release; the gate only turns green on the numbers.
- Isolation: the two-tenant fixture passes for every tool.
- Idempotency: replaying the same webhook or crashing mid-run produces exactly one order and one write-back.
- Pilot metrics: minutes per order before and after, exceptions per 100 orders, time to first value under one hour.
- Discovery: 15 interviews, 10 sample documents per company, segment decision documented here.

## Status

- Week 1 in progress. See the repository README for what runs today.
