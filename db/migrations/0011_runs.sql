-- 0011_runs.sql : durability for the run job (WP-BE06).
--
-- A run is one build of one sheet, turned into something a user can watch: an id handed back
-- within two seconds, a row per stage, and a readable partial state when a stage times out.
-- Until this migration is applied a run lives in process memory (lib/run/store.ts), so it
-- resets on every serverless cold start and is invisible to another instance. That is enough
-- to exercise the seam and to run the tests, and it is NOT enough for production: on Vercel
-- the POST and the poll may land on different instances.
--
-- NOT YET APPLIED. No Postgres is provisioned for this product. This file is written and
-- reviewed; the flip step is the same as every other store here:
--   npm install postgres
--   psql "$DATABASE_URL" -f db/migrations/0011_runs.sql
--   set DATABASE_URL
--
-- Re-runnable by construction: create table if not exists, create index if not exists, and
-- drop policy if exists before create policy. Applying it twice changes nothing.
--
-- The application sets app.tenant_id per transaction (see withRls() in lib/run/postgres.ts);
-- the policy below pins every row to that tenant. Unlike 0005_monitor.sql there is NO
-- cross-tenant enumeration here: nothing reads runs without a request context, so the table
-- is under FORCE row-level security with no exception.

-- One row per run. The whole RunRecord lives in `record` as jsonb and is authoritative; the
-- columns beside it exist so a query can filter and order without opening the document.
create table if not exists run (
  tenant_id       text not null references tenant(id) on delete cascade,
  id              text not null,
  -- running | needs-choice | done | partial | failed. Kept as text rather than an enum so a
  -- new status needs no migration; the application owns the vocabulary (lib/run/types.ts).
  status          text not null,
  -- Exactly what the user typed, trimmed. A name or a company number.
  input           text not null,
  -- Null until the resolver lands on one company. Stays null on needs-choice, which is the
  -- whole point of a pick list: the run never guessed.
  company_number  text,
  -- Null until the manifest is assembled and saved. This is the tear_sheet.key to open.
  sheet_key       text,
  record          jsonb not null,
  started_at      timestamptz not null,
  updated_at      timestamptz not null default now(),
  primary key (tenant_id, id)
);

-- The poll path is load-by-id, which the primary key already serves. This index serves the
-- list path: a desk's recent runs, newest first.
create index if not exists run_tenant_started_idx on run (tenant_id, started_at desc);

-- Finding the runs still in flight (a sweep for jobs the platform killed mid-stage) should
-- not scan a desk's whole history.
create index if not exists run_tenant_status_idx on run (tenant_id, status);

-- --- Row-level security: the MNPI wall (mirror 0003_rls.sql / 0005_monitor.sql) ------------
-- FORCE matters as much as ENABLE: without it the table owner bypasses the policy, and the
-- application role is often the owner. The role must also not be superuser and not hold
-- BYPASSRLS, or these policies are silently skipped.
alter table run enable row level security;
alter table run force  row level security;

drop policy if exists run_tenant on run;
create policy run_tenant on run
  using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));
