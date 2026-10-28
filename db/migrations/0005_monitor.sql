-- 0005_monitor.sql : durability for change-detection monitoring and origination shortlists.
-- Until now the watchlist, the per-company snapshots, the recorded change events and the
-- saved origination shortlists lived only in process memory (lib/monitor/store.ts,
-- lib/workspace.ts), so they reset on every serverless cold start and never shared across
-- instances. These four tables give them the same durable, tenant-scoped home the tear
-- sheets and the graph already have, under the same row-level-security wall (mirror
-- 0003_rls.sql / 0004_graph.sql).
--
-- Apply with any Postgres provider:
--   psql "$DATABASE_URL" -f db/migrations/0005_monitor.sql
--
-- The application sets app.tenant_id per transaction (see lib/db/withTenant.ts); the
-- policies below pin every row to that tenant, so one desk can never read another's
-- watchlist, snapshots or events. The `tenant` table is intentionally NOT under RLS, so the
-- scheduled cron can enumerate which tenants hold watches without a request context.

-- Which companies a desk watches. One row per (tenant, company).
create table if not exists watchlist (
  tenant_id   text not null references tenant(id) on delete cascade,
  ch_number   text not null,
  added_at    timestamptz not null default now(),
  primary key (tenant_id, ch_number)
);
create index if not exists watchlist_tenant_idx on watchlist (tenant_id);

-- The latest captured snapshot per watched company (the diff baseline). Stored whole as
-- jsonb; one row per (tenant, company), overwritten on each re-check.
create table if not exists monitor_snapshot (
  tenant_id   text not null references tenant(id) on delete cascade,
  ch_number   text not null,
  snapshot    jsonb not null,
  taken_at    timestamptz not null default now(),
  primary key (tenant_id, ch_number)
);

-- The recorded cited change events, append-only. `seq` gives a stable tiebreak so events
-- sharing an observed_at keep a deterministic order (most-recent first on read).
create table if not exists change_event (
  seq          bigint generated always as identity,
  tenant_id    text not null references tenant(id) on delete cascade,
  ch_number    text not null,
  kind         text not null,
  detail       text not null,
  provenance   jsonb not null,
  observed_at  timestamptz not null,
  primary key (tenant_id, seq)
);
create index if not exists change_event_tenant_idx on change_event (tenant_id, observed_at desc, seq desc);

-- Saved origination shortlists: a whole OriginationSuggestion as jsonb, one per (tenant,
-- target), overwritten on re-save. Does not fit the FactManifest contract, so it lives
-- here rather than in tear_sheet.
create table if not exists shortlist (
  tenant_id   text not null references tenant(id) on delete cascade,
  target_id   text not null,
  suggestion  jsonb not null,
  saved_at    timestamptz not null default now(),
  primary key (tenant_id, target_id)
);
create index if not exists shortlist_tenant_idx on shortlist (tenant_id);

-- --- Row-level security: the MNPI wall (mirror 0003_rls.sql / 0004_graph.sql) --------------
alter table watchlist        enable row level security;
alter table watchlist        force  row level security;
alter table monitor_snapshot enable row level security;
alter table monitor_snapshot force  row level security;
alter table change_event     enable row level security;
alter table change_event     force  row level security;
alter table shortlist        enable row level security;
alter table shortlist        force  row level security;

drop policy if exists watchlist_tenant on watchlist;
create policy watchlist_tenant on watchlist
  using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));

drop policy if exists monitor_snapshot_tenant on monitor_snapshot;
create policy monitor_snapshot_tenant on monitor_snapshot
  using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));

drop policy if exists change_event_tenant on change_event;
create policy change_event_tenant on change_event
  using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));

drop policy if exists shortlist_tenant on shortlist;
create policy shortlist_tenant on shortlist
  using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));
