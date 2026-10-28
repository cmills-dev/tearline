-- 0001_init.sql
-- Initial persistence schema for the origination engine. Every row carries tenant_id
-- from day one, because tenancy and the MNPI wall cannot be retrofitted onto a
-- single-tenant store. Row-level security is the enforcement point for the wall; enable
-- it per deployment (see the policies at the foot of this file).
--
-- Apply with any Postgres provider (Supabase, Vercel Postgres, Neon, plain Postgres):
--   psql "$DATABASE_URL" -f db/migrations/0001_init.sql

create table if not exists tenant (
  id          text primary key,
  name        text not null,
  created_at  timestamptz not null default now()
);

create table if not exists entity (
  tenant_id       text not null references tenant(id) on delete cascade,
  company_number  text not null,
  company_name    text not null,
  synthetic       boolean not null default false,   -- real vs illustrative, always explicit
  created_at      timestamptz not null default now(),
  primary key (tenant_id, company_number)
);

-- A tear sheet is a validated FactManifest, stored whole (jsonb) plus the contract
-- version it was written under, so a future contract change can find and migrate it.
create table if not exists tear_sheet (
  tenant_id         text not null references tenant(id) on delete cascade,
  key               text not null,                  -- record key (e.g. company number)
  contract_version  text not null,
  company_name      text not null,
  synthetic         boolean not null default false,
  manifest          jsonb not null,
  saved_at          timestamptz not null default now(),
  primary key (tenant_id, key)
);

-- Facts are also exploded into rows for query/coverage (the fact/coverage API), keyed
-- back to their tear sheet. The whole Fact contract object is kept in payload so nothing
-- is lost to the columns.
create table if not exists fact (
  tenant_id       text not null references tenant(id) on delete cascade,
  tear_sheet_key  text not null,
  fact_id         text not null,
  metric          text not null,
  period          text not null,
  rung            text not null check (rung in ('R1','R2','R3','R4')),
  payload         jsonb not null,
  created_at      timestamptz not null default now(),
  primary key (tenant_id, tear_sheet_key, fact_id),
  foreign key (tenant_id, tear_sheet_key) references tear_sheet(tenant_id, key) on delete cascade
);

create index if not exists tear_sheet_tenant_idx on tear_sheet (tenant_id);
create index if not exists fact_tenant_metric_idx on fact (tenant_id, metric);
create index if not exists fact_tenant_rung_idx   on fact (tenant_id, rung);

-- --- The MNPI wall: row-level security -------------------------------------------------
-- Enable and add a policy that pins every query to the current tenant. The application
-- sets `app.tenant_id` per request; no row from another tenant is ever visible.
--   alter table entity     enable row level security;
--   alter table tear_sheet enable row level security;
--   alter table fact       enable row level security;
--   create policy tenant_isolation on tear_sheet
--     using (tenant_id = current_setting('app.tenant_id', true));
--   (repeat for entity and fact)
