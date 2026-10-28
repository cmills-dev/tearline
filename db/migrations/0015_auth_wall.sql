-- 0015_auth_wall.sql : the wall around the auth tables (WP-QA05, finding of 27 Sep).
--
-- NAMING. `app_user` is two things. The TABLE public.app_user holds one row per person (email,
-- password hash, tenant). The ROLE app_user is the login the runtime connects as. Below, "the
-- table" and "the role" say which one is meant.
--
-- WHAT WAS OPEN. roles.sql grants the role select, insert, update and delete on every table. The
-- table public.app_user and the table public.session carry no row-level security, because login
-- reads a user by email before any tenant is known. So anyone who could run SQL as the role could
-- read every user's email and password hash, and every session row, across all tenants.
--
-- WHAT THIS DOES. The role loses every direct privilege on both tables. It reaches them only
-- through the six functions below, one per thing the runtime does before a tenant is known.
-- Each is SECURITY DEFINER (it runs as the owner that ran this migration), has its search_path
-- pinned, names its tables with the schema, and answers for one exact key only:
--   auth_find_user(email)            login: one row for that exact email, or none
--   auth_email_taken(email)          registration: true or false, no row data
--   auth_create_user(...)            registration: insert one user
--   auth_session_create(...)         sign-in: insert one session for a user of that tenant
--   auth_session_load(token_hash)    every signed-in request: one session, or none
--   auth_session_revoke(token_hash)  logout and expiry: delete one session
-- There is no function that lists users or sessions. An empty or null key matches nothing.
--
-- A SECOND LAYER. Row-level security is ENABLED on both tables with NO policy, and not forced.
-- For the role that means zero rows even if a later hand-run of roles.sql grants select again.
-- The owner, who runs the functions, is exempt because the tables do not FORCE it. Foreign-key
-- checks and cascades run as the owner too, so they are unaffected.
--
-- ORDER. db-migrate now runs roles.sql before the numbered files (lib/db/migrate.ts), so on a
-- fresh database the role exists here and roles.sql cannot re-grant after this revoke. On a
-- database where roles.sql already ran, the revoke below is the last word. The ledger never
-- re-runs either file, so a second db-migrate leaves the revoke in place.
--
-- Runnable by the non-superuser owner (neondb_owner on Neon): it owns the tables, so it can
-- revoke on them, create functions and enable row-level security. Idempotent: create or replace,
-- revoke and grant are safe to repeat.

-- The role, in case this runs before roles.sql on some database (same block as roles.sql).
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_user') then
    create role app_user login;
  end if;
end
$$;

-- Login. Only the four columns login reads. Exact match on the lower-cased email the app sends.
create or replace function public.auth_find_user(p_email text)
returns table (id uuid, email text, password_hash text, tenant_id text)
language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select u.id, u.email, u.password_hash, u.tenant_id
    from public.app_user u
   where p_email is not null and p_email <> '' and u.email = p_email
   limit 1
$$;

-- Registration: is this email taken? A boolean, so a caller learns nothing else.
create or replace function public.auth_email_taken(p_email text)
returns boolean
language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select exists (
    select 1 from public.app_user u
     where p_email is not null and p_email <> '' and u.email = p_email
  )
$$;

-- Registration: one new user. A duplicate email still raises the unique violation, which the
-- register path turns into "exists".
create or replace function public.auth_create_user(p_id uuid, p_email text, p_password_hash text, p_tenant_id text)
returns void
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if p_email is null or p_email = '' then
    raise exception 'auth_create_user: email is required';
  end if;
  insert into public.app_user (id, email, password_hash, tenant_id)
  values (p_id, p_email, p_password_hash, p_tenant_id);
end;
$$;

-- Sign-in: one session for a user, and only in that user's own tenant.
create or replace function public.auth_session_create(p_token_hash text, p_user_id uuid, p_tenant_id text, p_expires_at timestamptz)
returns void
language plpgsql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if p_token_hash is null or p_token_hash = '' then
    raise exception 'auth_session_create: token hash is required';
  end if;
  insert into public.session (token_hash, user_id, tenant_id, expires_at)
  select p_token_hash, u.id, u.tenant_id, p_expires_at
    from public.app_user u
   where u.id = p_user_id and u.tenant_id = p_tenant_id;
  if not found then
    raise exception 'auth_session_create: no such user in that tenant';
  end if;
end;
$$;

-- Every signed-in request: the session for one token hash, or none.
create or replace function public.auth_session_load(p_token_hash text)
returns table (user_id uuid, tenant_id text, expires_at timestamptz)
language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select s.user_id, s.tenant_id, s.expires_at
    from public.session s
   where p_token_hash is not null and p_token_hash <> '' and s.token_hash = p_token_hash
   limit 1
$$;

-- Logout and expiry: delete one session by its token hash.
create or replace function public.auth_session_revoke(p_token_hash text)
returns void
language sql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
  delete from public.session where token_hash = p_token_hash
$$;

-- Nobody but the role may call them. New functions are executable by PUBLIC by default.
revoke all on function public.auth_find_user(text) from public;
revoke all on function public.auth_email_taken(text) from public;
revoke all on function public.auth_create_user(uuid, text, text, text) from public;
revoke all on function public.auth_session_create(text, uuid, text, timestamptz) from public;
revoke all on function public.auth_session_load(text) from public;
revoke all on function public.auth_session_revoke(text) from public;

grant execute on function public.auth_find_user(text) to app_user;
grant execute on function public.auth_email_taken(text) to app_user;
grant execute on function public.auth_create_user(uuid, text, text, text) to app_user;
grant execute on function public.auth_session_create(text, uuid, text, timestamptz) to app_user;
grant execute on function public.auth_session_load(text) to app_user;
grant execute on function public.auth_session_revoke(text) to app_user;

-- The wall itself: no direct privilege on either table for the role.
revoke all on table public.app_user from app_user;
revoke all on table public.session from app_user;
revoke all on table public.app_user from public;
revoke all on table public.session from public;

-- The second layer: row-level security on, no policy, not forced.
alter table public.app_user enable row level security;
alter table public.session  enable row level security;
