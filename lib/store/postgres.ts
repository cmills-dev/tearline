// lib/store/postgres.ts
// The DURABLE persistence adapter: a PostgresTearSheetStore implementing the same
// three-method TearSheetStore seam against db/migrations/0001_init.sql. Provider-agnostic
// through DATABASE_URL, so Supabase, Neon, Vercel Postgres and plain Postgres all work
// unchanged.
//
// The `postgres` (postgres.js) client is loaded via a GUARDED DYNAMIC IMPORT, never a
// static dependency, so the build passes WITHOUT it installed. The flip is exactly:
//   1. npm install postgres
//   2. psql "$DATABASE_URL" -f db/migrations/0001_init.sql   (and enable RLS policies)
//   3. set DATABASE_URL
// getStore() then returns this store automatically.

import type { FactManifest } from "../engine/types";
import { CONTRACT_VERSION } from "../contracts";
import {
  assertPersistable,
  type StoredRef,
  type TearSheetStore,
} from "./tearSheetStore";

// The minimal slice of the postgres.js tagged-template client we use. Kept local so this
// file needs no @types for an optional peer dependency.
interface Sql {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<Record<string, unknown>[]>;
  json(value: unknown): unknown;
  begin<T>(fn: (sql: Sql) => Promise<T>): Promise<T>;
}

let sqlSingleton: Sql | null = null;

// Resolve a Postgres connection string from whatever a provider injects. Plain Postgres
// uses DATABASE_URL; Vercel Marketplace integrations (Neon, Supabase, Vercel Postgres)
// inject POSTGRES_URL and friends. Accepting all of them means connecting a resource is
// the only step - no code change after provisioning.
//
// APP_DATABASE_URL comes first (WP-DS01). The Neon integration puts its OWNER role into
// DATABASE_URL and POSTGRES_URL, and the owner bypasses the RLS wall. APP_DATABASE_URL carries
// the app_user role, so setting it is enough to win over whatever the integration injects.
export function databaseUrl(): string | undefined {
  return (
    process.env.APP_DATABASE_URL ||
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.POSTGRES_URL_NON_POOLING
  );
}

// Lazily construct the client on first use. The dynamic import is guarded so a build
// without the package installed still type-checks and compiles; the import only runs when
// a database URL is set and a call is actually made.
async function getSql(): Promise<Sql> {
  if (sqlSingleton) return sqlSingleton;
  const url = databaseUrl();
  if (!url) throw new Error("PostgresTearSheetStore requires DATABASE_URL / POSTGRES_URL");
  // The webpackIgnore comment keeps the bundler from trying to resolve `postgres` at build
  // time, so the build passes without it installed; the import resolves at runtime once
  // the package is present (the flip step).
  const mod = await import(/* webpackIgnore: true */ "postgres");
  const postgres = (mod.default ?? mod) as unknown as (url: string, opts?: unknown) => Sql;
  // A conservative pool: serverless functions are short-lived and many may run at once,
  // so keep the per-instance connection count low.
  sqlSingleton = postgres(url, { max: 3, idle_timeout: 20, prepare: false });
  return sqlSingleton;
}

export class PostgresTearSheetStore implements TearSheetStore {
  // A default tenant name is used when a tenant row does not yet exist. The tenant id is
  // whatever the caller passes; the id is the enforcement key for the MNPI wall.
  async save(tenantId: string, key: string, manifest: FactManifest): Promise<void> {
    // Never write a manifest that violates the frozen contract.
    assertPersistable(manifest);
    const sql = await getSql();
    const entity = manifest.entity;

    await sql.begin(async (tx) => {
      // Set the tenant for this transaction so row-level security (db/migrations/0003_rls.sql)
      // is enforced by the database, not only by the WHERE clauses below. `true` => SET LOCAL,
      // so the value is scoped to this transaction and safe under a connection pooler.
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      // Tenant must exist before any row that references it.
      await tx`
        insert into tenant (id, name)
        values (${tenantId}, ${tenantId})
        on conflict (id) do nothing
      `;

      // Entity row (one per company number within the tenant).
      await tx`
        insert into entity (tenant_id, company_number, company_name, synthetic)
        values (${tenantId}, ${entity.companyNumber}, ${entity.companyName}, ${entity.synthetic})
        on conflict (tenant_id, company_number)
        do update set company_name = excluded.company_name,
                      synthetic = excluded.synthetic
      `;

      // The whole validated manifest, stamped with the contract version it was written
      // under, as jsonb.
      await tx`
        insert into tear_sheet
          (tenant_id, key, contract_version, company_name, synthetic, manifest, saved_at)
        values
          (${tenantId}, ${key}, ${CONTRACT_VERSION}, ${entity.companyName},
           ${entity.synthetic}, ${tx.json(manifest)}, now())
        on conflict (tenant_id, key)
        do update set contract_version = excluded.contract_version,
                      company_name = excluded.company_name,
                      synthetic = excluded.synthetic,
                      manifest = excluded.manifest,
                      saved_at = now()
      `;

      // Explode facts into rows for the coverage / fact API. Replace wholesale so a
      // re-save never leaves orphaned facts from a prior manifest.
      await tx`delete from fact where tenant_id = ${tenantId} and tear_sheet_key = ${key}`;
      for (const fact of Object.values(manifest.facts)) {
        await tx`
          insert into fact
            (tenant_id, tear_sheet_key, fact_id, metric, period, rung, payload)
          values
            (${tenantId}, ${key}, ${fact.id}, ${fact.metric}, ${fact.period},
             ${fact.rung}, ${tx.json(fact)})
        `;
      }
    });
  }

  async load(tenantId: string, key: string): Promise<FactManifest | null> {
    const sql = await getSql();
    // Read inside a transaction that sets the tenant GUC, so RLS is enforced on the read too.
    const rows = await sql.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      return tx`
        select manifest from tear_sheet
        where tenant_id = ${tenantId} and key = ${key}
        limit 1
      `;
    });
    if (rows.length === 0) return null;
    return rows[0].manifest as FactManifest;
  }

  async list(tenantId: string): Promise<StoredRef[]> {
    const sql = await getSql();
    const rows = await sql.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      return tx`
        select key, company_name, synthetic, saved_at
        from tear_sheet
        where tenant_id = ${tenantId}
        order by saved_at desc
      `;
    });
    return rows.map((r) => ({
      tenantId,
      key: String(r.key),
      companyName: String(r.company_name),
      synthetic: Boolean(r.synthetic),
      savedAt:
        r.saved_at instanceof Date
          ? r.saved_at.toISOString()
          : String(r.saved_at),
    }));
  }
}
