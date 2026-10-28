# 4. Persistence, tenancy, auth, and the MNPI wall

Multi-tenancy is a first-class concern: a credit desk's tips and workspace must be invisible to any
other tenant. Tenancy is an explicit argument on every store call, so the wall has somewhere to stand
from day one.

## The store (`lib/store/`)

`TearSheetStore` - one interface, three methods, all tenant-scoped:
`save(tenantId, key, manifest)`, `load(tenantId, key)`, `list(tenantId)`. A manifest is validated
against the frozen contract before it is written (`assertPersistable`), so a contract-violating record
can never be stored.

`getStore()` picks the implementation from the environment:

- No `DATABASE_URL` -> **InMemoryTearSheetStore** (per-process; keeps the demo self-contained).
- `DATABASE_URL` set -> **PostgresTearSheetStore** (`postgres.ts`) against `db/migrations/0001_init.sql`.

`storeIsDurable()` lets the UI say honestly whether a record survives a restart.

## The workspace (`lib/workspace.ts`, `lib/tenant.ts`)

`getTenantId()` resolves the current tenant from the request (the single choke point). A verified
session binds the tenant to a signed-in user; absent one, it falls back to an anonymous per-browser
`tid` cookie (demo mode) unless `AUTH_REQUIRED=1`. `lib/workspace.ts` is the save/list/load loop:
`getTearSheet(tenantId, key)` generates-then-saves on first view and reads-back-from-store on the next,
so a tear sheet becomes a durable, tenant-scoped record. Two browsers see two separate workspaces.

## Auth (`lib/auth/`, `db/migrations/0002_auth.sql`)

Zero new runtime dependencies:

- `crypto.ts` - scrypt password hashing (`hashPassword` / `verifyPassword`), an HMAC-signed cookie
  envelope (`sign` / `verify`), and a session-token fingerprint.
- `session.ts` - the signed session `{ userId, tenantId, email, exp }` in an httpOnly `sid` cookie,
  with expiry + tamper enforced on decode. The signature lets middleware reject a forgery cheaply;
  the DB `session` table (revocable) is authoritative.
- `0002_auth.sql` - `app_user`, `session` (stores the token fingerprint, not the token),
  `source_entitlement` (per-tenant per-source flags - the BYO wall), and an append-only `audit_log`
  with an immutability trigger.

## The enforced wall - Postgres RLS (`db/migrations/0003_rls.sql`)

Row-level security on `entity`, `tear_sheet`, `fact`, `source_entitlement`, keyed on a
transaction-scoped GUC:

```
select set_config('app.tenant_id', $1, true);  -- true => SET LOCAL, pooler-safe
```

then run the tenant's queries in the same transaction. **The app DB role must not be superuser or
have BYPASSRLS**, or the policies are silently skipped. Under a transaction pooler, use only
`SET LOCAL` / `set_config(..., true)`, never plain `SET` (which would leak a tenant to the next
client on a recycled backend).

## Status

The crypto, session, tenant-resolution, and migrations are built and unit-tested (`test/auth.test.ts`).
The login UI, the DB-backed session/user store methods, and the `withTenant()` RLS transaction wrapper
are the **DB-gated flip-step**: they need a live Postgres to verify end-to-end. Enabling the wall is a
`DATABASE_URL` + migration + `AUTH_REQUIRED=1` step, not new code architecture.
