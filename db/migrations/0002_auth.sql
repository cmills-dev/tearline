-- 0002_auth.sql : authentication + the MNPI entitlement wall.
-- Zero new runtime dependencies (node:crypto hashes passwords; see lib/auth/crypto.ts).
-- Sessions are DB-backed and revocable (the signed cookie only proves non-forgery cheaply
-- in middleware; this table is authoritative).

create table if not exists app_user (
  id            uuid primary key default gen_random_uuid(),
  email         text unique not null,
  password_hash text not null,             -- scrypt$salt$hash
  tenant_id     text not null references tenant(id) on delete cascade,
  created_at    timestamptz not null default now()
);

create table if not exists session (
  token_hash  text primary key,            -- HMAC fingerprint of the opaque token
  user_id     uuid not null references app_user(id) on delete cascade,
  tenant_id   text not null references tenant(id) on delete cascade,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);
create index if not exists session_user_idx on session(user_id);

-- Per-source entitlement: which data sources a tenant is licensed to use (the BYO wall).
create table if not exists source_entitlement (
  tenant_id text not null references tenant(id) on delete cascade,
  source    text not null,                 -- 'sec' | 'companies-house' | 'esef' | 'bloomberg' | ...
  enabled   boolean not null default false,
  primary key (tenant_id, source)
);

-- Append-only audit log: who accessed which tenant's data, when.
create table if not exists audit_log (
  id        bigint generated always as identity primary key,
  tenant_id text not null,
  user_id   uuid,
  action    text not null,                 -- 'view_tear_sheet' | 'login' | 'save' | ...
  target    text,
  at        timestamptz not null default now()
);

-- Immutability: audit rows can be inserted but never updated or deleted.
create or replace function audit_log_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'audit_log is append-only';
end;
$$;
drop trigger if exists audit_log_no_mutate on audit_log;
create trigger audit_log_no_mutate
  before update or delete on audit_log
  for each row execute function audit_log_immutable();
