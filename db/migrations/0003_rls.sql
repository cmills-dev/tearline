-- 0003_rls.sql : Postgres row-level security, the enforced MNPI wall.
-- The application role must NOT be superuser and must NOT have BYPASSRLS, or these policies
-- are silently skipped. Set the tenant once per transaction with a transaction-scoped GUC:
--
--   select set_config('app.tenant_id', $1, true);   -- the `true` => SET LOCAL, pooler-safe
--
-- then run the tenant's queries in the same transaction (see withTenant() in
-- lib/store/postgres.ts). Never use plain SET under a transaction pooler: the value would
-- leak to the next client on a recycled backend.

alter table entity           enable row level security;
alter table entity           force  row level security;
alter table tear_sheet       enable row level security;
alter table tear_sheet       force  row level security;
alter table fact             enable row level security;
alter table fact             force  row level security;
alter table source_entitlement enable row level security;
alter table source_entitlement force  row level security;

drop policy if exists entity_tenant on entity;
create policy entity_tenant on entity
  using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));

drop policy if exists tear_sheet_tenant on tear_sheet;
create policy tear_sheet_tenant on tear_sheet
  using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));

drop policy if exists fact_tenant on fact;
create policy fact_tenant on fact
  using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));

drop policy if exists source_entitlement_tenant on source_entitlement;
create policy source_entitlement_tenant on source_entitlement
  using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));
