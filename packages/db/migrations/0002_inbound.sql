-- 0002_inbound.sql
-- Inbound mailboxes are resolved before a tenant context exists (orders+<slug>@...).

CREATE OR REPLACE FUNCTION resolve_inbound_mailbox(p_slug text)
RETURNS TABLE (tenant_id uuid, principal_id uuid)
LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT t.id, p.id
  FROM tenants t
  JOIN principals p ON p.tenant_id = t.id AND p.kind = 'service' AND p.display_name = 'inbound-email' AND p.status = 'active'
  WHERE t.slug = p_slug
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION resolve_inbound_mailbox(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_inbound_mailbox(text) TO app_user;
