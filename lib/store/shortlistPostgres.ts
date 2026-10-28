// lib/store/shortlistPostgres.ts
// The DURABLE ShortlistStore, mirroring lib/store/postgres.ts: the `postgres` client is a
// GUARDED DYNAMIC IMPORT so the build passes without it installed, and it activates only when
// DATABASE_URL is set (see getShortlistStore). It implements the same seam
// InMemoryShortlistStore does, against the shortlist table in db/migrations/0005_monitor.sql.
// Every method runs inside a transaction that pins app.tenant_id, so row-level security
// enforces the MNPI wall on the database, not only in the WHERE clause.

import type { OriginationSuggestion } from "../originate/suggestion";
import { databaseUrl } from "./postgres";
import { type SavedSuggestion, type ShortlistStore, suggestionId } from "./shortlistStore";

interface Sql {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<Record<string, unknown>[]>;
  json(value: unknown): unknown;
  begin<T>(fn: (sql: Sql) => Promise<T>): Promise<T>;
}

let sqlSingleton: Sql | null = null;
async function getSql(): Promise<Sql> {
  if (sqlSingleton) return sqlSingleton;
  const url = databaseUrl();
  if (!url) throw new Error("PostgresShortlistStore requires DATABASE_URL");
  const mod = await import(/* webpackIgnore: true */ "postgres");
  const postgres = (mod.default ?? mod) as unknown as (url: string, opts?: unknown) => Sql;
  sqlSingleton = postgres(url, { max: 3, idle_timeout: 20, prepare: false });
  return sqlSingleton;
}

async function withRls<T>(tenantId: string, fn: (tx: Sql) => Promise<T>): Promise<T> {
  const sql = await getSql();
  return sql.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  });
}

export class PostgresShortlistStore implements ShortlistStore {
  async save(tenantId: string, suggestion: OriginationSuggestion): Promise<SavedSuggestion> {
    const savedAt = new Date().toISOString();
    const record: SavedSuggestion = { ...suggestion, savedAt };
    const id = suggestionId(suggestion);
    await withRls(tenantId, async (tx) => {
      await tx`insert into tenant (id, name) values (${tenantId}, ${tenantId}) on conflict (id) do nothing`;
      await tx`
        insert into shortlist (tenant_id, target_id, suggestion, saved_at)
        values (${tenantId}, ${id}, ${tx.json(record)}, ${savedAt})
        on conflict (tenant_id, target_id)
        do update set suggestion = excluded.suggestion, saved_at = excluded.saved_at
      `;
    });
    return record;
  }

  async list(tenantId: string): Promise<SavedSuggestion[]> {
    const rows = await withRls(tenantId, (tx) => tx`
      select suggestion from shortlist
      where tenant_id = ${tenantId}
      order by saved_at desc
    `);
    // The whole SavedSuggestion (including savedAt) is stored in the jsonb, so it round-trips
    // faithfully; the saved_at column exists only for ordering.
    return rows.map((r) => r.suggestion as SavedSuggestion);
  }
}
