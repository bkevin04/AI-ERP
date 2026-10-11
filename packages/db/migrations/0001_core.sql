-- 0001_core.sql
-- Core schema: identity, ERP records, agentic layer, provenance.
-- Conventions:
--   * every tenant-owned table has tenant_id and a row-level-security policy
--   * append-only tables revoke UPDATE/DELETE from app_user and raise from a trigger
--   * the app connects as a role that is a member of app_user (never the owner)

CREATE EXTENSION IF NOT EXISTS pg_trgm;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION app_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END $$;

-- ---------------------------------------------------------------------------
-- identity
-- ---------------------------------------------------------------------------
CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  autonomy_level int NOT NULL DEFAULT 1 CHECK (autonomy_level BETWEEN 0 AND 2),
  agents_paused_at timestamptz,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE principals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  kind text NOT NULL CHECK (kind IN ('human','agent','service')),
  display_name text NOT NULL,
  email text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX principals_tenant_idx ON principals(tenant_id);

CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  principal_id uuid NOT NULL REFERENCES principals(id),
  key_hash text NOT NULL UNIQUE,
  scopes text[] NOT NULL DEFAULT '{}',
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  UNIQUE (tenant_id, name)
);
CREATE TABLE role_scopes (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  scope text NOT NULL,
  PRIMARY KEY (role_id, scope)
);
CREATE TABLE principal_roles (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  principal_id uuid NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (principal_id, role_id)
);

CREATE TABLE agent_policies (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  principal_id uuid PRIMARY KEY REFERENCES principals(id) ON DELETE CASCADE,
  allowed_tools text[],
  auto_commit_enabled boolean NOT NULL DEFAULT false,
  max_auto_order_value numeric(14,2),
  rate_limit_per_hour int,
  killed_at timestamptz
);

-- ---------------------------------------------------------------------------
-- ERP core
-- ---------------------------------------------------------------------------
CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  normalized_name text NOT NULL,
  email_domains text[] NOT NULL DEFAULT '{}',
  billing_address jsonb,
  ship_to jsonb NOT NULL DEFAULT '[]'::jsonb,
  default_price_list_id uuid,
  payment_terms text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customers_tenant_idx ON customers(tenant_id);
CREATE INDEX customers_name_trgm_idx ON customers USING gin (normalized_name gin_trgm_ops);
CREATE INDEX customers_domains_idx ON customers USING gin (email_domains);

CREATE TABLE customer_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  email text NOT NULL,
  name text,
  UNIQUE (tenant_id, customer_id, email)
);
CREATE INDEX customer_contacts_email_idx ON customer_contacts(tenant_id, email);

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  sku text NOT NULL,
  sku_norm text NOT NULL,
  name text NOT NULL,
  description text,
  base_uom text NOT NULL DEFAULT 'EA',
  barcode text,
  pack_factors jsonb NOT NULL DEFAULT '{}'::jsonb,
  list_price numeric(14,4),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  search tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(sku,'') || ' ' || coalesce(name,'') || ' ' || coalesce(description,''))
  ) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sku_norm)
);
CREATE INDEX products_tenant_idx ON products(tenant_id);
CREATE INDEX products_barcode_idx ON products(tenant_id, barcode);
CREATE INDEX products_search_idx ON products USING gin (search);
CREATE INDEX products_name_trgm_idx ON products USING gin (name gin_trgm_ops);

CREATE TABLE product_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES customers(id) ON DELETE CASCADE,
  alias_type text NOT NULL CHECK (alias_type IN ('customer_part_no','description','synonym')),
  alias_norm text NOT NULL,
  uom_override text,
  source text NOT NULL CHECK (source IN ('correction','import','inferred')),
  created_from_correction_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX product_aliases_lookup_idx ON product_aliases(tenant_id, alias_norm, customer_id);

CREATE TABLE price_lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  currency char(3) NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  valid_from date,
  valid_to date
);
CREATE INDEX price_lists_tenant_idx ON price_lists(tenant_id);

CREATE TABLE price_list_items (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  price_list_id uuid NOT NULL REFERENCES price_lists(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  min_qty numeric(14,4) NOT NULL DEFAULT 0,
  unit_price numeric(14,4) NOT NULL,
  uom text,
  PRIMARY KEY (price_list_id, product_id, min_qty)
);

CREATE TABLE customer_price_lists (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  price_list_id uuid NOT NULL REFERENCES price_lists(id) ON DELETE CASCADE,
  priority int NOT NULL DEFAULT 0,
  PRIMARY KEY (customer_id, price_list_id)
);

CREATE TABLE stock_snapshots (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  location text NOT NULL DEFAULT 'default',
  qty_available numeric(14,4) NOT NULL,
  as_of timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, location)
);

CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  kind text NOT NULL CHECK (kind IN ('email','pdf','xlsx','csv','image','text','edi')),
  storage_key text NOT NULL,
  sha256 text NOT NULL,
  mime text NOT NULL,
  filename text,
  parent_document_id uuid REFERENCES documents(id),
  text_key text,
  page_count int,
  from_address text,
  provider_message_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sha256)
);
CREATE INDEX documents_provider_msg_idx ON documents(tenant_id, provider_message_id);

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  number text NOT NULL,
  customer_id uuid NOT NULL REFERENCES customers(id),
  status text NOT NULL CHECK (status IN ('draft','pending_review','approved','committed','written_back','rejected')),
  customer_po_number text,
  currency char(3) NOT NULL,
  requested_date date,
  ship_to jsonb,
  totals jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_from_proposal_id uuid UNIQUE,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);
CREATE INDEX orders_customer_po_idx ON orders(tenant_id, customer_id, customer_po_number);

CREATE TABLE order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  line_no int NOT NULL,
  product_id uuid REFERENCES products(id),
  description text NOT NULL,
  qty numeric(14,4) NOT NULL,
  uom text NOT NULL,
  unit_price numeric(14,4),
  line_total numeric(14,4),
  match_method text,
  match_confidence numeric(5,4),
  evidence jsonb,
  UNIQUE (order_id, line_no)
);

-- ---------------------------------------------------------------------------
-- agentic layer
-- ---------------------------------------------------------------------------
CREATE TABLE events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX events_tenant_type_idx ON events(tenant_id, type, occurred_at);

CREATE TABLE agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  principal_id uuid NOT NULL REFERENCES principals(id),
  trigger_event_id uuid REFERENCES events(id),
  workflow text NOT NULL,
  status text NOT NULL,
  attempt int NOT NULL DEFAULT 1,
  prompt_version text,
  policy_version text,
  model_id text,
  token_usage jsonb,
  cost_usd numeric(10,4),
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trigger_event_id, workflow)
);
CREATE INDEX agent_runs_tenant_status_idx ON agent_runs(tenant_id, status);

CREATE TABLE run_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  seq int NOT NULL,
  kind text NOT NULL CHECK (kind IN ('llm_call','tool_call','policy_check','gate','code')),
  name text NOT NULL,
  input jsonb,
  output jsonb,
  idempotency_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('ok','error')),
  duration_ms int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, idempotency_key)
);
CREATE INDEX run_steps_run_idx ON run_steps(run_id, seq);

CREATE TABLE proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  run_id uuid REFERENCES agent_runs(id),
  kind text NOT NULL CHECK (kind IN ('create_order')),
  payload jsonb NOT NULL,
  payload_schema_version int NOT NULL DEFAULT 1,
  confidence numeric(5,4) NOT NULL,
  confidence_breakdown jsonb NOT NULL,
  flags text[] NOT NULL DEFAULT '{}',
  explanation text NOT NULL DEFAULT '',
  policy_result jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('proposed','checks_failed','pending_approval','auto_approved','approved','rejected','committed','superseded')),
  supersedes_id uuid REFERENCES proposals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX proposals_queue_idx ON proposals(tenant_id, status, created_at);

CREATE TABLE approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  proposal_id uuid NOT NULL REFERENCES proposals(id),
  decision text NOT NULL CHECK (decision IN ('approve','edit_and_approve','reject')),
  decided_by uuid NOT NULL REFERENCES principals(id),
  edited_payload jsonb,
  comment text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  proposal_id uuid NOT NULL REFERENCES proposals(id),
  field_path text NOT NULL,
  original jsonb,
  corrected jsonb,
  scope text NOT NULL CHECK (scope IN ('tenant','customer','product')),
  customer_id uuid REFERENCES customers(id),
  product_id uuid REFERENCES products(id),
  created_rule_id uuid,
  created_by uuid NOT NULL REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  scope text NOT NULL CHECK (scope IN ('tenant','customer','product')),
  customer_id uuid REFERENCES customers(id) ON DELETE CASCADE,
  product_id uuid REFERENCES products(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('alias','default_uom','default_ship_to','few_shot','threshold')),
  condition jsonb NOT NULL DEFAULT '{}'::jsonb,
  action jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  version int NOT NULL DEFAULT 1,
  created_from_correction_id uuid REFERENCES corrections(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rules_lookup_idx ON rules(tenant_id, kind, customer_id) WHERE active;

CREATE TABLE provenance_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  entity_version int,
  action text NOT NULL,
  run_id uuid,
  step_id uuid,
  proposal_id uuid,
  approval_id uuid,
  policy_version text,
  prompt_version text,
  model_id text,
  source_document_ids uuid[] NOT NULL DEFAULT '{}',
  actor_principal_id uuid NOT NULL,
  diff jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX provenance_entity_idx ON provenance_entries(tenant_id, entity_type, entity_id, created_at);
CREATE INDEX provenance_run_idx ON provenance_entries(run_id);

CREATE TABLE prompt_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id),
  name text NOT NULL,
  version text NOT NULL,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name, version)
);

CREATE TABLE policy_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  version text NOT NULL,
  rules jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, version)
);

CREATE TABLE connectors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  kind text NOT NULL CHECK (kind IN ('odoo','business_central','netsuite','quickbooks','dryrun')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret_ref text,
  mode text NOT NULL DEFAULT 'sandbox' CHECK (mode IN ('sandbox','live')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE connector_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  connector_id uuid NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  internal_id uuid NOT NULL,
  external_id text NOT NULL,
  external_version text,
  sync_hash text,
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connector_id, entity_type, internal_id),
  UNIQUE (connector_id, entity_type, external_id)
);

CREATE TABLE writebacks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  order_id uuid NOT NULL REFERENCES orders(id),
  connector_id uuid NOT NULL REFERENCES connectors(id),
  idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','confirmed','failed')),
  external_id text,
  request jsonb,
  response jsonb,
  attempts int NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX writebacks_pending_idx ON writebacks(tenant_id, status) WHERE status IN ('pending','failed');

CREATE TABLE idempotency_keys (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  principal_id uuid NOT NULL,
  tool text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, principal_id, tool, key)
);

CREATE TABLE tool_invocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  principal_id uuid NOT NULL,
  tool text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tool_invocations_rate_idx ON tool_invocations(tenant_id, principal_id, at);

-- ---------------------------------------------------------------------------
-- evaluation
-- ---------------------------------------------------------------------------
CREATE TABLE eval_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  document_ids uuid[] NOT NULL,
  ground_truth jsonb NOT NULL,
  master_data_snapshot_id text,
  source text NOT NULL CHECK (source IN ('historical','from_approval','synthetic')),
  tags text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE eval_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  prompt_version text,
  policy_version text,
  model_id text,
  summary jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE TABLE eval_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  eval_run_id uuid NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
  case_id uuid NOT NULL REFERENCES eval_cases(id) ON DELETE CASCADE,
  proposal jsonb,
  field_scores jsonb NOT NULL,
  UNIQUE (eval_run_id, case_id)
);

CREATE TABLE autonomy_gates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  segment text NOT NULL DEFAULT 'default',
  prompt_version text,
  policy_version text,
  model_id text,
  auto_precision numeric(5,4),
  n_cases int NOT NULL DEFAULT 0,
  green boolean NOT NULL DEFAULT false,
  evaluated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, segment)
);

-- ---------------------------------------------------------------------------
-- row-level security, grants, append-only enforcement
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO app_user;

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'principals','api_keys','roles','role_scopes','principal_roles','agent_policies',
    'customers','customer_contacts','products','product_aliases','price_lists','price_list_items',
    'customer_price_lists','stock_snapshots','documents','orders','order_lines',
    'events','agent_runs','run_steps','proposals','approvals','corrections','rules','provenance_entries',
    'policy_versions','connectors','connector_mappings','writebacks','idempotency_keys','tool_invocations',
    'eval_cases','eval_runs','eval_results','autonomy_gates'
  ];
  append_only text[] := ARRAY['events','run_steps','approvals','corrections','provenance_entries','prompt_versions','policy_versions'];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_user', t);
  END LOOP;

  -- tenants: a session can only see its own tenant row
  ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
  ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
  CREATE POLICY tenant_self ON tenants USING (id = app_tenant_id());
  GRANT SELECT ON tenants TO app_user;

  -- prompt_versions: shared (tenant_id null) or own
  ALTER TABLE prompt_versions ENABLE ROW LEVEL SECURITY;
  ALTER TABLE prompt_versions FORCE ROW LEVEL SECURITY;
  CREATE POLICY prompt_visibility ON prompt_versions USING (tenant_id IS NULL OR tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
  GRANT SELECT, INSERT ON prompt_versions TO app_user;

  FOREACH t IN ARRAY append_only LOOP
    EXECUTE format('REVOKE UPDATE, DELETE ON %I FROM app_user', t);
    EXECUTE format('CREATE TRIGGER %I_append_only BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION forbid_mutation()', t, t);
  END LOOP;
END $$;

-- API keys are looked up before a tenant context exists, so the lookup runs with the
-- owner's rights and returns exactly one principal plus its tenant.
CREATE OR REPLACE FUNCTION resolve_api_key(p_key_hash text)
RETURNS TABLE (
  principal_id uuid, tenant_id uuid, kind text, display_name text, key_scopes text[],
  role_scopes text[], allowed_tools text[], auto_commit_enabled boolean,
  max_auto_order_value numeric, rate_limit_per_hour int, killed_at timestamptz
)
LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT p.id, p.tenant_id, p.kind, p.display_name, k.scopes,
         coalesce((SELECT array_agg(DISTINCT rs.scope) FROM principal_roles pr JOIN role_scopes rs ON rs.role_id = pr.role_id WHERE pr.principal_id = p.id), '{}'),
         ap.allowed_tools, coalesce(ap.auto_commit_enabled, false), ap.max_auto_order_value, ap.rate_limit_per_hour, ap.killed_at
  FROM api_keys k
  JOIN principals p ON p.id = k.principal_id
  LEFT JOIN agent_policies ap ON ap.principal_id = p.id
  WHERE k.key_hash = p_key_hash
    AND (k.expires_at IS NULL OR k.expires_at > now())
    AND p.status = 'active'
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION resolve_api_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_api_key(text) TO app_user;
