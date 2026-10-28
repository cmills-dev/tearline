# Persistence

The product persists through one seam: `lib/store/tearSheetStore.ts` (the `TearSheetStore`
interface). Everything it produces is a validated `FactManifest`, saved and read back by
**tenant** and record key. Tenancy is a first-class argument on every call, so the MNPI
wall has somewhere to stand from day one.

## Default: in-memory

With nothing configured, `getStore()` returns an in-memory store. It exercises the seam
and keeps the demo self-contained, but records do not survive a process restart
(`storeIsDurable()` returns `false`). This is deliberate: the durable store is a
provider choice that is better made explicitly (see below).

## Durable: Postgres (the flip step)

1. Provision Postgres with any provider (Supabase, Vercel Postgres, Neon, or plain
   Postgres) and set `DATABASE_URL`.
2. Apply the schema: `psql "$DATABASE_URL" -f db/migrations/0001_init.sql`. Every table
   carries `tenant_id`; enable the row-level-security policies at the foot of the
   migration to enforce the MNPI wall.
3. Add a `PostgresTearSheetStore` implementing the three-method `TearSheetStore`
   interface against the `tenant` / `tear_sheet` / `fact` tables, and return it from
   `getStore()` when `DATABASE_URL` is set. `save()` must call `assertPersistable()`
   first (already shared), write the whole manifest to `tear_sheet.manifest` (jsonb) with
   `contract_version = CONTRACT_VERSION`, and explode its facts into `fact` rows.

The interface is intentionally tiny (`save` / `load` / `list`) so the adapter is a short,
well-scoped piece of work once the provider is chosen. A dedicated `postgres` (or `pg`)
dependency is added only at that point, so the current build ships nothing untested.

## Why the contract version is stored

Each record is written with the `CONTRACT_VERSION` (`lib/contracts`) it was produced
under. A breaking contract change bumps that version and can then find and migrate
older records rather than silently mis-reading them.

## 0004_graph.sql — relationship graph (Engine C)

Durable, tenant-scoped storage for the relationship graph (`graph_node`, `graph_edge`) under the
same RLS wall as the rest. Flip step (mirrors the tear-sheet store):

1. `npm install postgres`
2. `psql "$DATABASE_URL" -f db/migrations/0001_init.sql` … through `0004_graph.sql`
3. set `DATABASE_URL`

`getGraphStore()` then returns `PostgresGraphStore` automatically; `warmestPaths` runs over it
unchanged. The graph is populated from real filings by `lib/graph/ingest/*` (charges → lenders,
officers → people, PSC → owners, GLEIF → ultimate parent) and from client-stated relationships via
the conversational onboarding.

## Deploy sequence — the enforced MNPI wall

RLS is the wall, but it only holds if the app connects as a NON-OWNER role. A table's owner (and
any superuser) is exempt from RLS unless the table also FORCES it, and even with FORCE the safest
posture is to never let the app log in as the owner. The migrations now FORCE RLS on every
tenant-scoped table (0003..0007); the steps below put a non-owner role in front of them. Run them
in order:

1. **Apply the migrations as the owner/admin.** In order, 0001 through 0010:

   ```sh
   for f in db/migrations/00{01,02,03,04,05,06,07,08,09,10}_*.sql; do
     psql "$OWNER_DATABASE_URL" -f "$f"
   done
   ```

   0003..0007 are tenant-scoped and RLS-forced. 0008..0010 are the shared Tier-0 plane and carry
   NO RLS by design (de-identified / public facts shared across tenants); leave them global.

2. **Create the non-owner application role** (once, as the owner/admin):

   ```sh
   psql "$OWNER_DATABASE_URL" -f db/roles.sql
   ```

   Then set a real password for `app_user` (or manage it through your platform's secret manager);
   `db/roles.sql` ships with a `CHANGE_ME` placeholder on purpose.

3. **Point the app at the non-owner role.** Set `DATABASE_URL` to connect as `app_user`, NOT the
   owner/admin role. Keep the owner credentials for migrations and admin only, never in the app
   runtime. This is what makes FORCE RLS actually bite.

### Verify tenant isolation

Connect **as `app_user`** (not the owner) and prove one tenant cannot see another's row. The
`tenant` table is deliberately not under RLS, so the two tenant rows insert freely; `tear_sheet`
is RLS-forced, so it is the real test:

```sql
-- Seed two tenants (tenant table is not RLS-scoped).
insert into tenant (id, name) values ('tenant-a', 'Tenant A'), ('tenant-b', 'Tenant B')
  on conflict (id) do nothing;

-- Act as tenant-a and write one tear sheet.
select set_config('app.tenant_id', 'tenant-a', false);
insert into tear_sheet (tenant_id, key, contract_version, company_name, manifest)
  values ('tenant-a', 'ISO-CHECK', 'v1', 'Isolation Test Co', '{}'::jsonb);

-- tenant-a sees its row.
select count(*) from tear_sheet where key = 'ISO-CHECK';   -- expect 1

-- Switch to tenant-b: the tenant-a row must be invisible.
select set_config('app.tenant_id', 'tenant-b', false);
select count(*) from tear_sheet where key = 'ISO-CHECK';   -- expect 0

-- The WITH CHECK clause also blocks writing another tenant's row while acting as tenant-b:
insert into tear_sheet (tenant_id, key, contract_version, company_name, manifest)
  values ('tenant-a', 'ISO-CHECK-2', 'v1', 'Should Fail', '{}'::jsonb);
  -- expect: ERROR new row violates row-level security policy for table "tear_sheet"
```

If step two returns 1 (the tenant-a row is visible to tenant-b), the wall is NOT holding: you are
almost certainly connected as the owner/admin rather than `app_user`, or `DATABASE_URL` still
points at the owner role. Reconnect as `app_user` and re-run. The same check works against
`client_spec` (swap the columns for `tenant_id, version, spec` and a `jsonb` spec value).
