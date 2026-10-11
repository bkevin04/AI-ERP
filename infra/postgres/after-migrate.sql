-- Run once after `pnpm db:migrate`: give the login role the app_user privileges.
GRANT app_user TO app;
