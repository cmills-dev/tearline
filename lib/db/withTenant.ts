// lib/db/withTenant.ts
// The RLS choke point for durable queries. Postgres row-level security (db/migrations/
// 0003_rls.sql) reads the tenant from a transaction-scoped GUC, so every tenant-scoped
// query must run inside a transaction that has set it. withTenant() opens that transaction,
// sets app.tenant_id with SET LOCAL semantics (set_config(..., true)), and hands the
// transactional client to the callback. SET LOCAL is pooler-safe: the value is bound to the
// transaction and never leaks to the next client on a recycled backend, unlike plain SET.
//
// The `postgres` (postgres.js) client is loaded via a GUARDED DYNAMIC IMPORT, mirroring
// lib/store/postgres.ts, so the build passes WITHOUT the optional peer dependency installed.
// With no DATABASE_URL there is no database and no RLS to enforce, so this degrades to a
// no-op passthrough: the callback runs against an inert sql shim and the caller needs no
// branch of its own. Exported so the Postgres stores can adopt it once the flip lands.

import { databaseUrl } from "@/lib/store/postgres";

// The minimal slice of the postgres.js tagged-template client we use. Kept local so this
// file needs no @types for an optional peer dependency (same shape as lib/store/postgres.ts).
export interface Sql {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<Record<string, unknown>[]>;
  json(value: unknown): unknown;
  begin<T>(fn: (sql: Sql) => Promise<T>): Promise<T>;
}

let sqlSingleton: Sql | null = null;

async function getSql(): Promise<Sql> {
  if (sqlSingleton) return sqlSingleton;
  const url = databaseUrl();
  if (!url) throw new Error("withTenant requires DATABASE_URL / POSTGRES_URL");
  // The webpackIgnore comment keeps the bundler from resolving `postgres` at build time, so
  // the build passes without it installed; the import resolves at runtime once present.
  const mod = await import(/* webpackIgnore: true */ "postgres");
  const postgres = (mod.default ?? mod) as unknown as (url: string, opts?: unknown) => Sql;
  sqlSingleton = postgres(url, { max: 3, idle_timeout: 20, prepare: false });
  return sqlSingleton;
}

// An inert client used only when no database is configured, so callers can be written the
// same way in both modes. Every query returns no rows; a transaction just runs the body.
function makeNoopSql(): Sql {
  const q = (async () => [] as Record<string, unknown>[]) as unknown as Sql;
  q.json = (v: unknown) => v;
  q.begin = (async <T,>(f: (s: Sql) => Promise<T>) => f(q)) as Sql["begin"];
  return q;
}

// Run fn inside a transaction with app.tenant_id set for RLS. With no DATABASE_URL this is a
// no-op passthrough over an inert client.
export async function withTenant<T>(
  tenantId: string,
  fn: (sql: Sql) => Promise<T>,
): Promise<T> {
  if (!databaseUrl()) return fn(makeNoopSql());
  const sql = await getSql();
  return sql.begin(async (tx) => {
    // set_config(key, value, is_local=true) is the parameterised form of SET LOCAL: the
    // setting lives only for this transaction, so a pooled backend never leaks it onward.
    await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  });
}
