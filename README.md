# AI-ERP

An AI-native operations system for small product businesses. Agents do the data entry and
repetitive follow-ups; people review, correct and teach; every change is permissioned and
audited. The first process it owns end to end is **order intake**: customer emails, PDFs
and spreadsheets become validated sales orders in the ERP the company already runs.

Read first: [`docs/strategy.md`](docs/strategy.md) (why this and not a SAP plugin or a new
finance ERP), [`docs/architecture.md`](docs/architecture.md) (how it is built),
[`docs/roadmap.md`](docs/roadmap.md) (week by week), [`docs/discovery-script.md`](docs/discovery-script.md)
(how to find the first customers).

## What runs today (week 1)

- `packages/core`: the tool registry and `invokeTool` choke point (scopes, agent policies, kill switch,
  rate limits, idempotency, provenance), deterministic customer and product matching, pricing,
  policy, the run executor with step replay, and the order intake pipeline.
- `packages/db`: Postgres schema with row-level security and append-only ledgers, migration runner,
  the Postgres store, and PGlite-backed tests that prove tenant isolation.
- `packages/llm`: versioned prompts and structured-output calls to Claude.
- `packages/connector-sdk` and `packages/connector-odoo`: the ERP connector contract, dry-run
  connector, master-data sync, and the Odoo JSON-RPC implementation with search-before-create push.
- `packages/mcp`: every tool exposed over the Model Context Protocol through the same choke point.
- `packages/eval`: scorer, aggregate metrics and the autonomy gate.
- `apps/api`: Hono API (`/v1/tools/:name`, `/v1/documents`, `/v1/proposals`, Postmark inbound webhook, `/mcp`).
- `apps/worker`: pg-boss consumers for intake runs and master-data sync.
- `infra`: docker-compose (Postgres, MinIO, Odoo 17, Mailpit) and a seed that fills Odoo with a
  synthetic distributor and writes 60 purchase-order documents with ground truth.

## Quickstart

```bash
pnpm install
pnpm typecheck && pnpm test          # no Docker needed: db tests run on PGlite

pnpm infra:up                        # Postgres, MinIO, Odoo, Mailpit
cp .env.example .env                 # fill ANTHROPIC_API_KEY (or run `ant auth login`)
pnpm db:migrate                      # as postgres (DATABASE_ADMIN_URL)
psql "$DATABASE_ADMIN_URL" -f infra/postgres/after-migrate.sql
pnpm db:seed-dev demo                # prints the admin and agent API keys
pnpm odoo:seed                       # synthetic distributor in Odoo + infra/odoo/out/*.{txt,xlsx,pdf}
pnpm dev:api                         # :3000
pnpm dev:worker
```

Then:

```bash
# list tools
curl -s localhost:3000/v1/tools -H "authorization: Bearer $ADMIN_KEY" | jq '.tools[].name'

# upload a synthetic PO and start an intake run
curl -s localhost:3000/v1/documents -H "authorization: Bearer $ADMIN_KEY" -H 'content-type: application/json' \
  -d "{\"filename\":\"case-000.txt\",\"mime\":\"text/plain\",\"fromAddress\":\"buyer@acmeindustrialsupply.example.com\",\"contentBase64\":\"$(base64 -w0 infra/odoo/out/case-000.txt)\"}"

# review queue
curl -s "localhost:3000/v1/proposals?status=pending_approval" -H "authorization: Bearer $ADMIN_KEY" | jq
```

Any MCP client can point at `http://localhost:3000/mcp` with the agent API key as a bearer token
and call `find_customer`, `match_product_line`, `create_order_proposal` and `ingest_document`
with exactly the permissions the agent principal has.

## Layout

See [`docs/architecture.md`](docs/architecture.md#repository-layout).
