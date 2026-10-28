-- 0006_clientspec.sql : durability for per-tenant ClientSpecs and onboarding state.
-- Until now the induced ClientSpecs (the Module 1 client-understanding output) and the
-- onboarding wizard's progress lived only in process memory (lib/clientspec/store.ts), so they
-- reset on every serverless cold start and never shared across instances. These two tables give
-- them the same durable, tenant-scoped home the tear sheets, the graph and the shortlists
-- already have, under the same row-level-security wall (mirror 0005_monitor.sql).
--
-- Apply with any Postgres provider:
--   psql "$DATABASE_URL" -f db/migrations/0006_clientspec.sql
--
-- The application sets app.tenant_id per transaction (see lib/clientspec/postgres.ts); the
-- policies below pin every row to that tenant, so one desk can never read another's specs or
-- onboarding state.

-- The versioned ClientSpecs, one row per (tenant, version). The whole spec is stored as jsonb;
-- saveSpec assigns the next version (max existing + 1) so the history is monotonic and never
-- overwritten.
create table if not exists client_spec (
  tenant_id   text not null references tenant(id) on delete cascade,
  version     int not null,
  spec        jsonb not null,
  created_at  timestamptz not null default now(),
  primary key (tenant_id, version)
);
create index if not exists client_spec_tenant_idx on client_spec (tenant_id);

-- The onboarding wizard progress, one row per tenant, overwritten on each step. Holds the
-- active spec pointer (activeSpecVersion) inside the jsonb state.
create table if not exists onboarding_state (
  tenant_id   text not null references tenant(id) on delete cascade,
  state       jsonb not null,
  updated_at  timestamptz not null default now(),
  primary key (tenant_id)
);

-- --- Row-level security: the tenant wall (mirror 0005_monitor.sql) -------------------------
alter table client_spec      enable row level security;
alter table client_spec      force  row level security;
alter table onboarding_state enable row level security;
alter table onboarding_state force  row level security;

drop policy if exists client_spec_tenant on client_spec;
create policy client_spec_tenant on client_spec
  using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));

drop policy if exists onboarding_state_tenant on onboarding_state;
create policy onboarding_state_tenant on onboarding_state
  using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));
