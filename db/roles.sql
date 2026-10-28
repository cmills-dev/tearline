-- db/roles.sql : the non-owner application login role. Run ONCE by an admin/owner AFTER the
-- migrations (0001..0010) have been applied.
--
-- WHY THIS EXISTS (read before you skip it):
--   Row-level security has a sharp edge. A table's OWNER (and any superuser, and any role with
--   BYPASSRLS) is EXEMPT from RLS policies unless the table also has FORCE ROW LEVEL SECURITY.
--   The migrations now FORCE RLS on every tenant-scoped table, so the owner is no longer exempt.
--   But FORCE only bites when the application connects as a role that is NOT the owner: if the app
--   logs in as the table owner, FORCE still applies to the owner too, yet you are one `alter table`
--   away from a wall that is only the app-level WHERE clauses. On managed Postgres (Supabase,
--   Neon, Vercel Postgres, RDS) the default connection string is frequently the owner/admin role,
--   which is exactly the trap this file closes.
--
--   The fix is defence in depth: the app connects as a dedicated NON-OWNER login role
--   (`app_user`) that owns no tables and has no BYPASSRLS. For that role the tenant policies in
--   0003..0007 are always enforced by the database itself, not just by application code. If a
--   query ever forgets its `WHERE tenant_id = ...`, or the GUC is unset, the database returns
--   nothing rather than another tenant's MNPI.
--
--   DATABASE_URL MUST use this `app_user` role, NOT the owner/admin role. That is the whole point.
--   Keep the owner credentials for migrations and admin only; never ship them to the app runtime.

-- 1. The login role the application connects as. Owns nothing; no BYPASSRLS; no superuser.
--    Created WITHOUT a password and only if it does not already exist, so this file is idempotent
--    (safe to re-run) and never commits a credential to the repo. Set the secret OUT OF BAND before
--    the app connects - via your platform's role/secret manager, or in psql:
--        \password app_user
--    then point DATABASE_URL at this role. Some managed platforms authenticate by IAM/cert instead,
--    in which case no password is needed at all. NEVER hardcode a real password here.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_user') then
    create role app_user login;
  end if;
end
$$;

-- 2. Let the role reach the schema and the current tables. (grant is idempotent - safe to re-run.)
grant usage on schema public to app_user;
grant select, insert, update, delete on all tables in schema public to app_user;

-- 3. Identity/serial columns (e.g. change_event.seq, feedback_event.seq) need sequence access.
grant usage, select on all sequences in schema public to app_user;

-- 4. Make the grants apply to tables and sequences created by FUTURE migrations too, so a new
--    migration does not silently lock the app out. These defaults attach to objects created by
--    the role that runs THIS script (the owner/admin), which is who runs the migrations.
alter default privileges in schema public
  grant select, insert, update, delete on tables to app_user;
alter default privileges in schema public
  grant usage, select on sequences to app_user;
