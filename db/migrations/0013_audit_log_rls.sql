-- 0013_audit_log_rls.sql : row-level security on audit_log (WP-QA05, from WP-QA03).
-- audit_log (0002_auth.sql) carries tenant_id but had no policy, so the application role could
-- read and append any desk's audit rows. It now follows every other tenant table: the tenant is
-- pinned per transaction with set_config('app.tenant_id', $1, true), and a row is visible and
-- writable only under its own tenant. The append-only trigger from 0002 still stands.
--
-- A cross-desk audit review needs a separate role with BYPASSRLS; the application role must not
-- have it (see 0003_rls.sql).

alter table audit_log enable row level security;
alter table audit_log force  row level security;

drop policy if exists audit_log_tenant on audit_log;
create policy audit_log_tenant on audit_log
  using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));
