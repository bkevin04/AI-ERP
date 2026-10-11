-- The API and worker connect as "app", a member of app_user (created by the first migration),
-- so row-level security applies. Migrations run as "postgres".
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app') THEN
    CREATE ROLE app LOGIN PASSWORD 'app';
  END IF;
END $$;
