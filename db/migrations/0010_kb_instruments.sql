-- 0010_kb_instruments.sql : INSTRUMENTS on the SHARED Tier-0 KNOWLEDGE-GRAPH plane (Module 2).
--
-- DOCTRINE: an instrument is a debt tranche or a registered charge attached to a master entity,
-- detected from a tranche/charge fact metric (see lib/kb/graph.isInstrumentMetric) and accumulated
-- per source, so a charge seen on the Companies House register and a tranche seen in a filing both
-- hang off the entity. It carries no quantum of its own; it points at the fact metric that
-- quantifies it. Like master_entity / kb_document / kb_fact (db/migrations/0009_kb.sql), these are
-- PUBLIC facts shared ACROSS tenants, so this plane lives DELIBERATELY OUTSIDE the row-level-
-- security wall: there are NO RLS policies here ON PURPOSE and no tenant_id column. The
-- `entitlement` tag ('public' | 'entitled' | 'client') is modelled now so the export-policy layer
-- has something to read; only 'public' rows belong on this shared plane.
--
-- Apply with any Postgres provider:
--   psql "$DATABASE_URL" -f db/migrations/0010_kb_instruments.sql

-- An instrument accumulated on an entity, upserted by (master_id, instrument_id, source). A
-- re-ingest of the same instrument from the same source overwrites in place; the SAME instrument
-- from a DIFFERENT source is a separate row (corroboration), exactly like kb_fact lanes.
create table if not exists kb_instrument (
  master_id     text references master_entity(master_id) on delete cascade,
  instrument_id text,
  kind          text,
  label         text,
  metric        text,
  source        text,
  as_of         timestamptz,
  entitlement   text not null default 'public',
  primary key (master_id, instrument_id, source)
);

create index if not exists kb_instrument_master_id_idx on kb_instrument (master_id);
