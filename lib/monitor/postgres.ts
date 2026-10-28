// lib/monitor/postgres.ts
// The DURABLE MonitorStore, mirroring lib/store/postgres.ts and lib/graph/postgres.ts: the
// `postgres` client is a GUARDED DYNAMIC IMPORT so the build passes without it installed,
// and it activates only when DATABASE_URL is set (see getMonitorStore). It implements the
// same seam InMemoryMonitorStore does, against db/migrations/0005_monitor.sql, so runCheck
// and the routes are unchanged by the flip. The flip step is: npm install postgres; apply
// db/migrations/0005_monitor.sql; set DATABASE_URL.
//
// Every per-tenant method runs inside a transaction that first pins app.tenant_id, so
// row-level security enforces the MNPI wall on the database, not only in the WHERE clause.
// The ONE cross-tenant method is listTenantsWithWatches(): the scheduled cron has no request
// context and legitimately needs to know which tenants hold watches. It reads distinct
// tenant_ids WITHOUT a tenant GUC, which is why 0005 leaves the enumeration to a trusted job
// role; per-tenant data (snapshots, events, the watchlist itself) is never read that way, so
// no company's private state crosses the wall.

import type { MonitorStore, WatchEntry } from "./store";
import type { Snapshot, ChangeEvent } from "./types";
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
  if (!url) throw new Error("PostgresMonitorStore requires DATABASE_URL");
  const mod = await import(/* webpackIgnore: true */ "postgres");
  const postgres = (mod.default ?? mod) as unknown as (url: string, opts?: unknown) => Sql;
  sqlSingleton = postgres(url, { max: 3, idle_timeout: 20, prepare: false });
  return sqlSingleton;
}

// Run fn inside a transaction with app.tenant_id pinned, so RLS (0005_monitor.sql) is
// enforced on every statement. `true` => SET LOCAL (transaction-scoped, pooler-safe).
async function withRls<T>(tenantId: string, fn: (tx: Sql) => Promise<T>): Promise<T> {
  const sql = await getSql();
  return sql.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  });
}

// Normalise a CH number to a stable key, matching InMemoryMonitorStore.
function normNumber(chNumber: string): string {
  // All whitespace, as the memory store does: "12 345 678" trimmed only was a different watch and
  // a number Companies House does not know (WP-QA03 S3).
  return chNumber.replace(/\s+/g, "").toUpperCase();
}

// A tenant row must exist before any row that references it (same as the tear-sheet store).
async function ensureTenant(tx: Sql, tenantId: string): Promise<void> {
  await tx`insert into tenant (id, name) values (${tenantId}, ${tenantId}) on conflict (id) do nothing`;
}

export class PostgresMonitorStore implements MonitorStore {
  async addToWatchlist(tenantId: string, chNumber: string): Promise<void> {
    const num = normNumber(chNumber);
    await withRls(tenantId, async (tx) => {
      await ensureTenant(tx, tenantId);
      await tx`
        insert into watchlist (tenant_id, ch_number, added_at)
        values (${tenantId}, ${num}, now())
        on conflict (tenant_id, ch_number) do nothing
      `;
    });
  }

  async removeFromWatchlist(tenantId: string, chNumber: string): Promise<void> {
    const num = normNumber(chNumber);
    await withRls(tenantId, async (tx) => {
      await tx`delete from watchlist where tenant_id = ${tenantId} and ch_number = ${num}`;
      // The baseline goes with the watch, as in the memory store (WP-QA03 S2).
      await tx`delete from monitor_snapshot where tenant_id = ${tenantId} and ch_number = ${num}`;
    });
  }

  async listWatchlist(tenantId: string): Promise<WatchEntry[]> {
    const rows = await withRls(tenantId, (tx) => tx`
      select ch_number, added_at from watchlist
      where tenant_id = ${tenantId}
      order by added_at desc
    `);
    return rows.map((r) => ({
      chNumber: String(r.ch_number),
      addedAt: r.added_at instanceof Date ? r.added_at.toISOString() : String(r.added_at),
    }));
  }

  async saveSnapshot(snapshot: Snapshot): Promise<void> {
    const num = normNumber(snapshot.chNumber);
    await withRls(snapshot.tenantId, async (tx) => {
      await ensureTenant(tx, snapshot.tenantId);
      await tx`
        insert into monitor_snapshot (tenant_id, ch_number, snapshot, taken_at)
        values (${snapshot.tenantId}, ${num}, ${tx.json(snapshot)}, ${snapshot.takenAt})
        on conflict (tenant_id, ch_number)
        do update set snapshot = excluded.snapshot, taken_at = excluded.taken_at
      `;
    });
  }

  async loadSnapshot(tenantId: string, chNumber: string): Promise<Snapshot | null> {
    const num = normNumber(chNumber);
    const rows = await withRls(tenantId, (tx) => tx`
      select snapshot from monitor_snapshot
      where tenant_id = ${tenantId} and ch_number = ${num}
      limit 1
    `);
    return rows.length ? (rows[0].snapshot as Snapshot) : null;
  }

  async recordEvents(events: ChangeEvent[]): Promise<void> {
    if (events.length === 0) return;
    // Events in one batch always share a tenant (they come from one company's diff), but be
    // defensive and pin per distinct tenant so a mixed batch still lands under the right GUC.
    const byTenant = new Map<string, ChangeEvent[]>();
    for (const e of events) {
      const list = byTenant.get(e.tenantId) ?? [];
      list.push(e);
      byTenant.set(e.tenantId, list);
    }
    for (const [tenantId, list] of byTenant) {
      await withRls(tenantId, async (tx) => {
        await ensureTenant(tx, tenantId);
        for (const e of list) {
          // event_key makes an overlapping check's copy a no-op (0012_change_event_key.sql). An
          // unkeyed event has a null key, and nulls never conflict, so it is always kept.
          await tx`
            insert into change_event (tenant_id, ch_number, kind, detail, provenance, observed_at, event_key)
            values (${tenantId}, ${normNumber(e.chNumber)}, ${e.kind}, ${e.detail}, ${tx.json(e.provenance)}, ${e.observedAt}, ${e.key ?? null})
            on conflict (tenant_id, event_key) do nothing
          `;
        }
      });
    }
  }

  async listEvents(tenantId: string, limit = 50): Promise<ChangeEvent[]> {
    const cap = Math.max(0, Math.floor(limit));
    if (cap === 0) return [];
    const rows = await withRls(tenantId, (tx) => tx`
      select ch_number, kind, detail, provenance, observed_at from change_event
      where tenant_id = ${tenantId}
      order by observed_at desc, seq desc
      limit ${cap}
    `);
    return rows.map((r) => ({
      tenantId,
      chNumber: String(r.ch_number),
      kind: r.kind as ChangeEvent["kind"],
      detail: String(r.detail),
      provenance: r.provenance as ChangeEvent["provenance"],
      observedAt:
        r.observed_at instanceof Date ? r.observed_at.toISOString() : String(r.observed_at),
    }));
  }

  // The cron's cross-tenant enumeration. It must run with NO tenant GUC (the scheduled sweep has
  // no request context), so it CANNOT read `watchlist`: that table is FORCE RLS, and with the GUC
  // unset the policy matches no rows for the non-owner app_user role the deployment requires, which
  // would silently return zero tenants and disable monitoring. Enumerate from `tenant` instead,
  // which is deliberately NOT under RLS. It returns every known tenant; runCheckForTenant then reads
  // each tenant's watchlist strictly under that tenant's own GUC, and a tenant with no watches is a
  // harmless no-op. Only tenant IDs are exposed, never any company's watched state, so the wall holds.
  async listTenantsWithWatches(): Promise<string[]> {
    const sql = await getSql();
    const rows = await sql`select id from tenant order by id`;
    return rows.map((r) => String(r.id));
  }
}
