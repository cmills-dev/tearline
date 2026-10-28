-- 0008_shared_learning.sql : the DE-IDENTIFIED SHARED PLANE for RSI Phases 2 to 3.
--
-- DOCTRINE: these tables are shared ACROSS tenants and therefore live DELIBERATELY OUTSIDE the
-- row-level-security wall (unlike 0006_clientspec.sql / 0007_feedback.sql, which are tenant
-- scoped and RLS-protected). There are NO RLS policies here ON PURPOSE. That is only MNPI-safe
-- because the tables are strictly DE-IDENTIFIED: they store only a normalised label, a concept
-- key, a candidate status, one-way SHA-256 HASHES of tenant ids (for dedup), and COUNTS derived
-- from those hashes, plus promoted dictionary versions. They must NEVER store a raw tenant id,
-- raw client wording beyond the normalised label, or any figure. Storing any of those here would
-- breach the MNPI wall, because this plane is visible across tenants.
--
-- Promotion gates (k-anonymity, token filter, human sign-off, induction-eval) are enforced by
-- callers (lib/clientspec/sharedPostgres.ts, sharedStore.ts); this migration only shapes storage.
--
-- Apply with any Postgres provider:
--   psql "$DATABASE_URL" -f db/migrations/0008_shared_learning.sql

-- A candidate mapping: a normalised label that some tenants confirmed means a concept. The row
-- carries only the label, the concept and a review status; the distinct-tenant COUNT is derived
-- from synonym_candidate_contributor, never stored here.
create table if not exists synonym_candidate (
  label_norm   text not null,
  concept_key  text not null,
  status       text not null default 'pending',
  primary key (label_norm, concept_key)
);

-- The dedup ledger: one row per (candidate, one-way tenant hash). The hash lets us count DISTINCT
-- contributing tenants without ever learning which tenant used which term. The primary key makes
-- a tenant confirming twice idempotent, so the count never inflates. No raw tenant id is stored.
create table if not exists synonym_candidate_contributor (
  label_norm   text not null,
  concept_key  text not null,
  tenant_hash  text not null,
  primary key (label_norm, concept_key, tenant_hash)
);

-- The append-only promoted dictionary. Each version is a monotonic snapshot of approved entries
-- (label_norm -> concept_key only) plus who signed it off. Applied at induction after a tenant's
-- own synonyms and before the static base dictionary.
create table if not exists shared_dictionary_version (
  version      int primary key,
  entries      jsonb not null,
  approved_by  text not null,
  created_at   timestamptz not null default now()
);
