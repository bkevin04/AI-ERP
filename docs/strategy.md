# Strategy

Research date: 11 October 2026.

## The decision

Build an **AI-native operations system for small product businesses** (wholesale distributors, importers and brand wholesalers, small make-to-order manufacturers, 10 to 100 employees). It owns the core records (customers, products, price lists, orders, stock) and an inbox of work. Agents do the data entry and repetitive follow-ups. Employees review, correct, and teach. Everything runs with ERP-grade permissions, approvals, and an append-only audit trail. It connects to the accounting system or SMB ERP the company already has (Odoo first, QuickBooks Online second) instead of replacing it on day one.

**Order intake** from email, PDF and spreadsheets is the wedge feature and the demo, not the product. The product is the platform underneath: shared records, one permission model for humans and agents, provenance, connectors, an evaluation gate, and a "teach an agent" loop for the long tail of tasks nobody builds a startup for.

- Not a generic SAP plugin: SAP, Oracle, Microsoft and NetSuite bundle agent builders now; a horizontal plugin is a feature they absorb.
- Not a greenfield finance-first ERP: Rillet, Campfire, DualEntry, Light and Doss raised roughly half a billion dollars for that race and win on distribution.
- Not a single-process "email to order" agent: that wave is already served vertical by vertical.

## Market evidence

- **Finance-first AI-native ERP is a funded race.** Rillet $100M at $1B valuation (Aug 2026); Campfire ~$100M+; DualEntry $90M Series A; Light $43M; Doss $55M Series B. Sources: [erpresearch](https://www.erpresearch.com/en-us/ai-native-erp), [Fintech Global](https://fintech.global/2026/08/21/ai-erp-challenger-rillet-raises-100m-at-1bn-value/), [erpscorecard](https://erpscorecard.com/articles/campfire-erp-review-2026).
- **Incumbents bundle generic agents.** SAP Joule 40+ agents and Joule Studio; Oracle 1,000+ agents and a free Agent Studio; Microsoft Copilot Studio reasoning agents; NetSuite 2026.1 reconciliation agents. Sources: [Savic](https://www.savictech.com/insights/sap-joule-agentic-platform-40-agents-2026/), [Agent Intellect](https://agentintellect.net/oracle-fusion-cloud-ai-agents/), [erpimplementation.eu](https://www.erpimplementation.eu/en/agentic-ai-erp-comparison-sap-joule-sage-copilot-odoo-microsoft-2026/).
- **Single-process order intake is served vertical by vertical.** Food: Choco OrderAgent (preferred partner for 450+ UniPro distributors), Pepper, OrderAI. Building supply: Toolbx AI Order Entry GA Sept 2026. MEP: Remarcable, Trimble. Industrial: Conexiom, Esker, Avent (YC S25). Odoo: Workist, automaited, Oplify, AI Order Parser add-ons. Business Central: native Sales Order Agent GA. Sources: [Choco](https://choco.com/us/stories/suppliers/from-restaurant-app-to-ai-partner-for-distributors-the-evolution-of-choco), [Toolbx](https://distributionstrategy.com/2026/09/toolbx-launches-ai-order-entry-for-building-supply-distributors/), [Avent](https://www.ycombinator.com/launches/OC1-avent-ai-agents-for-industrial-commerce), [Odoo app store](https://apps.odoo.com/apps/modules/19.0/automaited_sales_order_ai), [Workist](https://www.workist.com/en/erp-integrations/odoo), [Tigunia on BC](https://tigunia.com/blog/business-central-ai-agents-controller-pre-flight-checklist/).
- **The manual work is real.** Email orders are 30 to 45% of distributor volume; 5 to 10 minutes per order; CSRs spend 20 to 40% of their time on manual order handling; 1 to 3% error rate. 77% of manufacturers forecast in spreadsheets, 79% enter most data by hand, 86% lost deals to slow quoting. Vendor-sourced, directional. Sources: [Bizowie](https://bizowie.com/how-distributors-can-automate-80-of-manual-order-entry), [Conexiom](https://conexiom.com/blog/the-real-cost-of-manual-order-entry-in-b2b-operations), [Concentrate 2026](https://www.concentrate.co.nz/manufacturing-state-of-industry-report-concentrate).
- **SMB inventory and order tools are not agent-native.** Cin7, inFlow, Katana, Zoho Inventory ship no agentic capability; nothing found that connects agents to QuickBooks or Xero for small wholesale brands. Source: [Energent](https://www.energent.ai/use-cases/en/compare/ai-powered-inventory-management-systems).
- **Replacement is rare and slow.** ~70% of ERP projects miss goals; 18 to 24 months; data migration is the killer. Sources: [Eide Bailly](https://www.eidebailly.com/insights/articles/2026/7/why-middle-market-erp-implementations-fail), [Acuity](https://acuityconsulting.net/blog/erp-implementation-in-2026-why-mid-market-companies-are-rethinking-their-approach).

**What this means.** Every vendor above had to build a mini-ERP (customer matching, catalog, pricing, approvals, write-back) to ship one agent. The gap is the platform that provides those primitives once, owns the records, and lets a non-technical ops person teach the next fifty small tasks safely.

## Target segment: three candidates, pick one by day 30

| Candidate | Why it fits | Who already serves it | Risk |
|---|---|---|---|
| **A. Specialty wholesale distributors** outside food and building supply (industrial consumables, packaging, medical and dental, salon and beauty, electronics components, pet, specialty chemicals). Order desk of 1 to 5 people. | Highest email order share, repetitive, revenue-touching, uniform task. | Conexiom and Esker at enterprise prices; Avent in industrial; generic Odoo add-ons. | Each sub-vertical has its own units, pack sizes, part numbers. |
| **B. Importers and own-brand wholesalers** selling to retailers | Usually on spreadsheets plus QuickBooks or Xero, so "be the system of record" is feasible early. | Cin7, inFlow, Zoho (not agentic); RepSpark, JOOR in apparel. | Seasonal; some sub-verticals already have B2B portals. |
| **C. Small make-to-order manufacturers and job shops** | Quoting, purchasing, order confirmation all manual. | Paperless Parts, MRPeasy, Katana. | Quoting needs costing knowledge; harder first agent. |

Decision criteria after 15 interviews: minutes per week on the wedge task, willingness to pilot free, budget owner reachable, task identical across companies, existing tools tried and rejected. **Default if inconclusive: A**, order intake first.

## How to reach them

- **Apollo list**: operations, customer service and inside sales managers and owners at wholesale, distribution and manufacturing companies, 10 to 100 employees, in the US, UK, Ireland, Canada, Australia, New Zealand and English-speaking Europe. 200 contacts per candidate segment.
- **Warm channels**: Odoo community forums and local Odoo partners, QuickBooks ProAdvisors and small accounting firms, r/smallbusiness, r/supplychain, r/manufacturing, LinkedIn distributor groups, NAW and MDM, sub-vertical associations, local chambers, university alumni and careers network.
- **The ask**: twenty minutes, "walk me through what happened to the last five orders that arrived by email". Collect ten anonymised sample documents per company.
- **The offer**: three free pilots for weekly feedback, sample documents and a testimonial; success metric agreed up front.
- **Outreach starts week one**, not after the MVP. Calls take three to four weeks to land; the week-3 demo video is the hook.

See `discovery-script.md` for the interview script and outreach email.

## Pricing hypothesis (test in interviews)

Flat tiers by processed document volume, roughly $199, $499 and $999 per month, not per seat. Land with order intake, expand with recipes. Avoid metered billing that makes pilots afraid to forward emails.

## Top risks and cheapest mitigation

- **Single-process commoditisation**: recipes two and three ship in the MVP so the pitch is the platform.
- **No one answers cold outreach**: five channels from week one; demo video by week three; Odoo partners and accountants as warm channels.
- **Wrong vertical**: three candidates, 15 interviews, decision by day 30, default A.
- **Extraction fails on ugly PDFs**: native PDF input plus evidence spans; failures route to review, never block; eval set built in week 3.
- **Synthetic data over-fits**: 20 real PO samples before week 4, traded for free pilots.
- **Wrong auto-commit with legal weight**: autonomy off by default, value caps, eval gate, reconcile surfaces ERP-side changes fast.
- **Duplicates and double write-back**: unique keys on events, runs, orders and writebacks, plus search-before-create.
- **Multi-tenancy leak**: row-level security plus a two-tenant test fixture on every tool.
- **Trust and data handling**: published data-handling page, dry-run mode, provenance ledger.
- **Odoo version drift**: pin `odoo:17`, connector contract tests against the container in CI, check Odoo 19 API at onboarding.
- **Solo-dev over-engineering**: one Postgres, one worker, no Temporal, no vectors, no microservices until a paying tenant forces it.
- **Cost and latency**: Haiku for triage and column mapping, stable prompt prefix with the document last for caching, Batches for eval replays.
