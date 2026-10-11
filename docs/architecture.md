# Architecture

## Principles (non-negotiable)

1. **Headless-first.** Every business operation is a typed, permissioned, idempotent tool. The web UI, the agent runtime and MCP clients all go through the same `invokeTool`.
2. **Agents are principals** in the same permission model as humans, with scopes, allowed tools, value caps, rate limits and a kill switch.
3. **Event-driven.** Event, run, proposal, deterministic policy checks, approval gate, commit, write-back, reconcile.
4. **Human review is a primitive.** Corrections become scoped rules.
5. **Append-only provenance** for every state change, written in the same transaction.
6. **The model extracts, disambiguates and communicates; code matches, prices, validates and commits.**
7. **Dry-run per tenant and an eval gate** before autonomy rises.
8. **Core tables are owned from day one;** connectors sync them.

## Stack

- pnpm workspaces plus Turborepo, TypeScript end to end, Drizzle ORM with plain-SQL migrations (so row-level security and append-only triggers are first-class), Vitest, tsx.
- `apps/api` Hono with the MCP HTTP transport mounted, `apps/worker` pg-boss consumers, `apps/web` Next.js (UI only, added in week 4). API and worker share `packages/core` in-process; no RPC between them.
- Postgres 16 with RLS (`tenant_id = current_setting('app.tenant_id')`, non-superuser app role, `SET LOCAL` per request and job), pg_trgm and tsvector for matching, S3-compatible object storage (MinIO locally), Mailpit as local SMTP sink.
- pg-boss for durable runs with a persisted step state machine; no Temporal. No pgvector until evals show description-only lines are the bottleneck.
- Claude via the Anthropic SDK with structured outputs. `claude-haiku-5-5` for triage and spreadsheet column mapping; `claude-opus-5-5` for extraction and disambiguation by default, with `claude-sonnet-5-5` evaluated for extraction in the harness. PDFs go in as native document blocks, so no separate OCR. Prompts and policies are versioned rows, not code.
- Connectors are TypeScript packages implementing one `ErpConnector` interface, called in-process; a generated MCP wrapper exposes the same interface. Odoo Community in Docker (pinned `odoo:17`, JSON-RPC) is the dev ERP. Pilots on Odoo 19 may need its newer JSON API; check at onboarding.
- Inbound email via Postmark inbound webhook to `orders+<tenant-slug>@in.<domain>`.

## Repository layout

```
apps/api            Hono: POST /v1/tools/:name, webhooks, auth, MCP transport
apps/worker         pg-boss consumers: run executor, sync, outbox, reconcile, eval
packages/contracts  zod schemas for entities, tool I/O, proposals, events
packages/db         Drizzle schema, SQL migrations (RLS, append-only triggers), tenant client, Postgres store
packages/core       defineTool / invokeTool registry, matching, pricing, policy, run state machine, intake pipeline
packages/llm        Anthropic wrapper, versioned prompts, structured-output helpers
packages/connector-sdk   ErpConnector interface, canonical types, DryRunConnector, master-data sync
packages/connector-odoo  JSON-RPC implementation, search-before-create push
packages/mcp        registry to MCP server adapter
packages/eval       case store, replay runner, scorers, gate computation
infra/              docker-compose (postgres, minio, odoo, mailpit), odoo/seed.ts
```

## Core data model

Every table carries `tenant_id` under RLS. Append-only tables (AO) revoke UPDATE and DELETE and raise on attempts.

- Identity: `tenants(autonomy_level, agents_paused_at)`, `principals(kind human|agent|service)`, `api_keys(scopes)`, `roles`, `role_scopes`, `principal_roles`, `agent_policies(allowed_tools, auto_commit_enabled, max_auto_order_value, rate_limit_per_hour, killed_at)`.
- ERP core: `customers(email_domains, default_price_list_id, ship_to)`, `customer_contacts`, `products(sku, barcode, base_uom, pack_factors, search tsvector)`, `product_aliases(customer_id nullable, alias_type, alias_norm, uom_override, source, created_from_correction_id)`, `price_lists`, `price_list_items`, `customer_price_lists`, `stock_snapshots`, `orders(status, customer_po_number, created_from_proposal_id UNIQUE, version)`, `order_lines(match_method, match_confidence, evidence)`, `documents(sha256 UNIQUE per tenant, provider_message_id, storage_key)`.
- Agentic layer: `events` AO (`idempotency_key UNIQUE`), `agent_runs` (`UNIQUE(trigger_event_id, workflow)`, prompt, policy and model versions, cost), `run_steps` AO (`idempotency_key = hash(run_id, seq, name, input)`), `proposals(payload, confidence_breakdown, flags, explanation, policy_result, supersedes_id)`, `approvals` AO, `corrections` AO, `rules(scope, kind alias|default_uom|default_ship_to|few_shot|threshold)`, `provenance_entries` AO, `prompt_versions` AO, `policy_versions` AO, `connectors`, `connector_mappings` (unique both directions, sync_hash), `writebacks` (the outbox, `idempotency_key UNIQUE`), `idempotency_keys`, `eval_cases`, `eval_runs`, `eval_results`, `autonomy_gates`.

## Tool pattern

`defineTool({ name, description, scope, sideEffects none|write|external, exposure [http|agent|mcp], idempotency, input, output, handler })`.

`invokeTool(ctx, name, input, { idempotencyKey })` is the single choke point: resolve principal, check scope and `agent_policies.allowed_tools`, kill switch, rate limit, validate input, idempotency lookup, open a transaction with `SET LOCAL app.tenant_id`, run handler, validate output, write `run_steps` and `provenance_entries`. Nothing else touches the database for business operations.

First tools: `find_customer`, `match_product_line`, `create_order_proposal` (runs policy checks inside), `ingest_document`. `commit_proposal` and `approve_proposal` are never in an agent's default allowed tools.

## Run lifecycle

`queued → running → proposed → checking → {checks_failed | pending_approval | auto_approved} → committing → committed → writing_back → written_back → reconciled`, with side exits `failed`, `cancelled`, `killed`.

1. Ingest (code): verify webhook signature, store raw payload and attachments, insert `documents` and `events` with `ON CONFLICT DO NOTHING`, enqueue run.
2. Preprocess (code): HTML to text with quoted-reply stripping, PDF text layer for evidence anchoring, SheetJS for spreadsheets.
3. Triage (Haiku): is this an order, which documents carry it. Non-orders end as `completed_noop`.
4. Extract (Opus, structured output, PDF as document block): raw observations only, no database access, pure and replayable.
5. Resolve (code): customer cascade, product cascade, unit normalisation, pricing engine, stock lookup, arithmetic, deterministic confidences.
6. Disambiguate (Opus, only ambiguous lines): pick from top-5 candidates or abstain, one-sentence reason.
7. Propose (code): order draft, confidence breakdown, flags, explanation.
8. Policy checks (code, versioned): schema, customer active, all lines above threshold, price within tolerance, total under agent cap, no duplicate PO, stock flags. Result `auto | review | block`.
9. Approval gate: `auto` only if tenant autonomy level 2, agent `auto_commit_enabled`, autonomy gate green, tenant not paused. Human outcomes: approve, edit-and-approve (diff becomes `corrections`), reject.
10. Commit (one transaction): orders, lines, provenance, outbox row. `created_from_proposal_id UNIQUE` makes it idempotent.
11. Write-back (outbox worker): `pushOrder` with idempotency key, search-before-create in the ERP, store external id.
12. Reconcile (scheduled): read status back; mismatches emit events and show on the timeline.

Retries replay completed `run_steps` instead of re-sampling the model. Kill switch at three levels (agent, tenant, global env) checked on dequeue, inside `invokeTool`, and before commit and write-back.

## Order intake specifics

- Customer cascade: contact email exact 0.95 → unique sender domain 0.85 → trigram name plus postal code 0.7 → PO prefix history → LLM disambiguation ≤ 0.65 → unresolved. Never auto-create customers in the MVP.
- Product cascade: customer alias 0.98 → normalised SKU 0.95 → barcode 0.95 → tenant alias 0.9 → trigram plus tsvector top-5 → LLM pick with abstain 0.6 to 0.8 → unmatched. Unit synonym table plus `pack_factors`; flag non-integer pack multiples.
- Pricing: customer price list by priority → tenant default → list price, with quantity breaks. A stated price outside tolerance raises `price_mismatch`; the customer's price is never accepted without a human.
- Confidence is deterministic: `min(customer_conf, min(line_conf)) - penalties(flags)`. Model self-confidence is a tie-breaker only.
- Autonomy levels: 0 drafts only, 1 everything reviewed, 2 auto-commit when policy passes and the gate is green.
- Corrections: reviewer maps raw text X to product B → offer "always map X to B for this customer" (default on) → `product_aliases` row. Same for units, ship-to and sender domain. Extraction-level corrections become per-customer few-shot rules, capped at 5.
- Prompt injection defence: the model never commits; policy and gate are code; the extraction step has no tools; document text is data in the user turn.

## Connector interface

`testConnection`, `pullCustomers`, `pullProducts`, `pullPriceLists`, `pullStock`, `findOrderByClientRef`, `pushOrder(order, idempotencyKey)`, `readOrderStatus`. Canonical types in `contracts`; `connector-sdk` owns upserts via `connector_mappings` with hash-based change detection. `DryRunConnector` records requests for sandbox tenants and tests.

Odoo mapping: `res.partner` (customers and contacts), `product.product` (`default_code` as SKU, `barcode`, `uom_id`, `qty_available`), `product.pricelist` and items, `sale.order` with `client_order_ref` as our order number and `order_line` commands. Later: Business Central OData v4 with `externalDocumentNumber`, NetSuite SuiteTalk REST with `externalId`, QuickBooks Online mapped to `Estimate` or `Invoice` (no sales order object; say so in the UI).

## Evaluation harness and autonomy gate

- Every approved proposal auto-creates an `eval_case` (prediction = proposal, truth = approved payload). Synthetic cases come from the Odoo seed with controlled noise.
- Replay runs steps 2 to 8 in eval mode against a pinned master-data snapshot, via the Batches API.
- Scores: header field accuracy; line precision, recall and F1 at three strictness levels; order-exact rate; triage accuracy. Headline safety metric is **auto-eligible precision**: among proposals policy would have auto-committed, the fraction exactly matching truth. Secondary: review load.
- Gate: level 2 allowed only when auto-eligible precision ≥ 0.99 over ≥ 50 cases with zero critical-field errors. Any prompt, policy or model change resets the gate to red; CI runs the eval on every PR touching `packages/llm` or policy code.
