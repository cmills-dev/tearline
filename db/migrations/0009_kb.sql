-- 0009_kb.sql : the SHARED Tier-0 KNOWLEDGE-GRAPH plane (Module 2 data layer).
--
-- DOCTRINE: these tables hold the master-ID entity spine and the cross-source facts accumulated
-- for each real-world company. The facts here are PUBLIC (Companies House, EDGAR, ESEF) and are
-- shared ACROSS tenants, so this plane lives DELIBERATELY OUTSIDE the row-level-security wall,
-- exactly like 0008_shared_learning.sql (and UNLIKE the tenant-scoped, RLS-protected
-- 0006_clientspec.sql / 0007_feedback.sql). There are NO RLS policies here ON PURPOSE, and no
-- tenant_id column: a public fact about a company is the same fact for every tenant, and resolving
-- one company seen through many sources to ONE master id is only possible on a shared spine.
--
-- The `entitlement` tag ('public' | 'entitled' | 'client') is modelled now so the export-policy
-- layer has something to read from day one. Only 'public' rows belong on this shared plane;
-- 'entitled'/'client' facts move to a per-tenant silo in a later migration. Storing a raw tenant
-- id or an entitled/client figure on THIS plane would breach the MNPI wall, since it is visible
-- across tenants.
--
-- Apply with any Postgres provider:
--   psql "$DATABASE_URL" -f db/migrations/0009_kb.sql

-- The master entity: one row per resolved real-world company. ch_number / cik / lei are the
-- cross-source JOIN KEYS (a name is never a join key); names/sources are the unioned display names
-- and contributing source ids. Indexed on each join key so resolveEntity finds bridging matches.
create table if not exists master_entity (
  master_id    text primary key,
  ch_number    text,
  cik          text,
  lei          text,
  primary_name text not null,
  names        jsonb not null default '[]',
  sources      jsonb not null default '[]',
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now()
);

create index if not exists master_entity_ch_number_idx on master_entity (ch_number);
create index if not exists master_entity_cik_idx on master_entity (cik);
create index if not exists master_entity_lei_idx on master_entity (lei);

-- A document contributed to an entity by a source, upserted by (master_id, doc_id). as_of is the
-- document's effective date (period end / filing date) for staleness; entitlement is the plane tag.
create table if not exists kb_document (
  master_id     text not null references master_entity(master_id) on delete cascade,
  doc_id        text not null,
  source        text,
  document_name text,
  retrieved_at  timestamptz,
  as_of         timestamptz,
  content_hash  text,
  entitlement   text not null default 'public',
  primary key (master_id, doc_id)
);

-- An accumulated fact. AMENDMENT PRECEDENCE is enforced by the store: for a (master_id, metric,
-- period) lane at most one row is live (superseded = false); a newer as_of supersedes the older
-- (kept for lineage), an older/equal as_of is inserted already superseded. Facts are never deleted.
create table if not exists kb_fact (
  id           bigint generated always as identity primary key,
  master_id    text references master_entity(master_id) on delete cascade,
  metric       text,
  period       text,
  value        jsonb,
  kind         text,
  unit         text,
  rung         text,
  source       text,
  doc_id       text,
  as_of        timestamptz,
  entitlement  text not null default 'public',
  provenance   jsonb,
  superseded   boolean not null default false,
  ingested_at  timestamptz not null default now()
);

-- The amendment lane lookup: find the live fact (and its lineage) for a metric/period fast.
create index if not exists kb_fact_lane_idx on kb_fact (master_id, metric, period, superseded);
