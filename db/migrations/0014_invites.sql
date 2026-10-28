-- 0014_invites.sql : invite-only registration (WP-DS05, DSD-12).
-- In production an account can only be made from an invite. An admin writes the invite with
-- scripts/add-user.ts for a named tenant. The invite link carries a random token; only its
-- SHA-256 is stored here, so the raw token is never at rest. An invite is bound to one email,
-- works once, and expires after seven days. Redeeming it creates the user in the invite's tenant.
--
-- Row-level security follows the other tenant tables: enabled, forced, and scoped by the
-- transaction-local app.tenant_id. Registration has no tenant yet, so the policy also shows the
-- one row whose token_hash equals app.invite_hash. The register path sets that GUC to the hash of
-- the token it was handed, and so can see that invite and nothing else. Writes still need
-- app.tenant_id: the register path sets it to the invite's tenant before it marks the row used.
--
--   select set_config('app.invite_hash', $1, true);   -- SET LOCAL, pooler-safe
--
-- The backlog named this 0012. 0012 and 0013 were taken by WP-QA05, so it is 0014.

create table if not exists invite (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   text not null references tenant(id) on delete cascade,
  email       text not null,                -- lower-cased on write
  token_hash  text unique not null,         -- sha256 hex of the token in the link
  expires_at  timestamptz not null,
  used_at     timestamptz,
  used_by     uuid references app_user(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists invite_tenant_idx on invite(tenant_id);
create index if not exists invite_email_idx on invite(email);

alter table invite enable row level security;
alter table invite force  row level security;

drop policy if exists invite_tenant on invite;
create policy invite_tenant on invite
  using (tenant_id = current_setting('app.tenant_id', true)
         or token_hash = current_setting('app.invite_hash', true))
  with check (tenant_id = current_setting('app.tenant_id', true));

-- The application role reaches the table like every other one. roles.sql grants on all tables
-- and sets default privileges, but on a fresh database it runs after the migrations, so the role
-- may not exist yet here. Grant only when it does; roles.sql covers the fresh case.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_user') then
    grant select, insert, update, delete on invite to app_user;
  end if;
end
$$;
