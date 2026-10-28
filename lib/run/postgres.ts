// lib/run/postgres.ts
// The DURABLE RunStore, mirroring lib/monitor/postgres.ts and lib/store/postgres.ts: the
// `postgres` client is a GUARDED DYNAMIC IMPORT so the build passes without it installed, and
// it activates only when DATABASE_URL is set (see getRunStore). It implements the same seam
// InMemoryRunStore does, against db/migrations/0011_runs.sql.
//
// NOT YET EXECUTED. No Postgres is provisioned for this product, so 0011_runs.sql has been
// written and reviewed but never applied, and every test runs against the memory store. The
// flip step is unchanged from the other stores: npm install postgres; apply the migration;
// set DATABASE_URL.
//
// Every method runs inside a transaction that first pins app.tenant_id, so row-level security
// enforces the wall on the database and not only in the WHERE clause. `true` on set_config
// means SET LOCAL, which is transaction-scoped and therefore safe under a connection pooler.
// There is no cross-tenant method here at all: unlike the monitor store, nothing enumerates
// runs without a request context.

import type { RunRecord } from "./types";
import type { RunStore } from "./store";
import { DEFAULT_LIST_LIMIT } from "./store";
import { databaseUrl } from "../store/postgres";

interface Sql {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<Record<string, unknown>[]>;
  json(value: unknown): unknown;
  begin<T>(fn: (sql: Sql) => Promise<T>): Promise<T>;
}

let sqlSingleton: Sql | null = null;

async function getSql(): Promise<Sql> {
  if (sqlSingleton) return sqlSingleton;
  const url = databaseUrl();
  if (!url) throw new Error("PostgresRunStore requires DATABASE_URL");
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

// A tenant row must exist before any row that references it, as in every other store here.
async function ensureTenant(tx: Sql, tenantId: string): Promise<void> {
  await tx`insert into tenant (id, name) values (${tenantId}, ${tenantId}) on conflict (id) do nothing`;
}

// The record is stored whole as jsonb, with the few fields a query would ever filter on
// lifted into columns. The jsonb is authoritative: read it back and you have the record the
// runner wrote, with no field-by-field reassembly to drift out of step with the type.
function fromRow(row: Record<string, unknown>): RunRecord {
  return row.record as RunRecord;
}

export class PostgresRunStore implements RunStore {
  async save(run: RunRecord): Promise<void> {
    await withRls(run.tenantId, async (tx) => {
      await ensureTenant(tx, run.tenantId);
      await tx`
        insert into run
          (tenant_id, id, status, input, company_number, sheet_key, record, started_at, updated_at)
        values
          (${run.tenantId}, ${run.id}, ${run.status}, ${run.input}, ${run.companyNumber},
           ${run.sheetKey}, ${tx.json(run)}, ${run.startedAt}, now())
        on conflict (tenant_id, id)
        do update set status         = excluded.status,
                      company_number = excluded.company_number,
                      sheet_key      = excluded.sheet_key,
                      record         = excluded.record,
                      updated_at     = now()
      `;
    });
  }

  async load(tenantId: string, id: string): Promise<RunRecord | null> {
    const rows = await withRls(tenantId, async (tx) => {
      return tx`select record from run where tenant_id = ${tenantId} and id = ${id} limit 1`;
    });
    if (rows.length === 0) return null;
    return fromRow(rows[0]);
  }

  async list(tenantId: string, limit = DEFAULT_LIST_LIMIT): Promise<RunRecord[]> {
    const rows = await withRls(tenantId, async (tx) => {
      return tx`
        select record from run
        where tenant_id = ${tenantId}
        order by started_at desc
        limit ${limit}
      `;
    });
    return rows.map(fromRow);
  }
}
