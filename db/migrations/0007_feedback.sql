-- 0007_feedback.sql : durability for the RSI Phase 1 per-client feedback loop (in-silo, MNPI-safe).
-- The client-understanding module now learns from a client's confirmed corrections: a synonym is
-- a label the client taught us maps to a concept (applied first at induction so their vocabulary
-- resolves on the next sheet), and a feedback event is the append-only audit trail of every
-- correction. Both stay strictly inside the client's own tenant (see docs/rsi-feedback-design.md);
-- promotion to a shared dictionary is a later, gated phase and is deliberately not here.
--
-- Until now these lived only in process memory (lib/clientspec/store.ts), so they reset on every
-- serverless cold start and never shared across instances. These two tables give them the same
-- durable, tenant-scoped home under the same row-level-security wall (mirror 0006_clientspec.sql).
--
-- Apply with any Postgres provider:
--   psql "$DATABASE_URL" -f db/migrations/0007_feedback.sql
--
-- The application sets app.tenant_id per transaction (see lib/clientspec/postgres.ts); the
-- policies below pin every row to that tenant, so one desk can never read another's synonyms or
-- feedback.

-- The learned synonyms, one row per (tenant, normalised label). addSynonym upserts by the primary
-- key so the latest confirmation wins; label_norm is already normalised on the way in
-- (lib/clientspec/concepts.normaliseLabel).
create table if not exists client_synonym (
  tenant_id     text not null references tenant(id) on delete cascade,
  label_norm    text not null,
  concept_key   text not null,
  source_label  text not null,
  confirmed_at  timestamptz not null default now(),
  primary key (tenant_id, label_norm)
);

-- The append-only feedback audit trail, one row per correction. seq is a per-database identity
-- that orders events within a tenant; the whole payload is stored as jsonb.
create table if not exists feedback_event (
  seq         bigint generated always as identity,
  tenant_id   text not null references tenant(id) on delete cascade,
  kind        text not null,
  payload     jsonb not null,
  created_at  timestamptz not null default now(),
  primary key (tenant_id, seq)
);
-- listFeedback returns newest first, capped at a limit; this index serves that ordering directly.
create index if not exists feedback_event_tenant_idx on feedback_event (tenant_id, created_at desc, seq desc);

-- --- Row-level security: the tenant wall (mirror 0006_clientspec.sql) -----------------------
alter table client_synonym enable row level security;
alter table client_synonym force  row level security;
alter table feedback_event enable row level security;
alter table feedback_event force  row level security;

drop policy if exists client_synonym_tenant on client_synonym;
create policy client_synonym_tenant on client_synonym
  using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));

drop policy if exists feedback_event_tenant on feedback_event;
create policy feedback_event_tenant on feedback_event
  using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));
