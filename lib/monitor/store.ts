// lib/monitor/store.ts
// The tenant-scoped monitoring store: a watchlist (which companies a desk watches), the
// latest snapshot per watched company, and the recorded change events. In-memory Maps keyed
// by tenant, exactly like the shortlist store in lib/workspace.ts, so one tenant can never
// see another's watches, snapshots or events. Every method takes an explicit tenantId (or a
// tenant-bearing record), so this module is pure and unit-testable with no request context.
//
// POSTGRES FOLLOW-UP: durability parity with the tear-sheet Postgres store would add three
// tables, watchlist(tenant_id, ch_number, added_at), snapshot(tenant_id, ch_number,
// manifest jsonb, taken_at) and change_event(tenant_id, ch_number, kind, detail, provenance
// jsonb, observed_at), all under the same row-level-security tenant GUC as tear_sheet (see
// lib/store/postgres.ts and db/migrations/0003_rls.sql). Until then watches, snapshots and
// events live for the life of the process, which is enough to exercise the seam and the
// cron sweep. Mirror the guarded-import pattern in postgres.ts when adding the durable
// adapter, so the build still passes without the `postgres` package installed.

import type { Snapshot, ChangeEvent } from "./types";
import { databaseUrl } from "../store/postgres";
import { PostgresMonitorStore } from "./postgres";

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface WatchEntry {
  chNumber: string;
  addedAt: string; // ISO
}

// The seam runCheck and the routes depend on. An async signature throughout, so a durable
// adapter (see the follow-up above) can be dropped in without changing a caller.
export interface MonitorStore {
  addToWatchlist(tenantId: string, chNumber: string): Promise<void>;
  removeFromWatchlist(tenantId: string, chNumber: string): Promise<void>;
  listWatchlist(tenantId: string): Promise<WatchEntry[]>;
  saveSnapshot(snapshot: Snapshot): Promise<void>;
  loadSnapshot(tenantId: string, chNumber: string): Promise<Snapshot | null>;
  recordEvents(events: ChangeEvent[]): Promise<void>;
  listEvents(tenantId: string, limit?: number): Promise<ChangeEvent[]>;
  // Enumerate the tenants that hold at least one watch, so the cron sweep can re-check every
  // desk's list without a request context.
  listTenantsWithWatches(): Promise<string[]>;
}

// Normalise a Companies House number to a stable key: upper-case, trimmed, no spaces. CH
// numbers are 8 characters, sometimes with a leading letter, so casing is the only wobble.
function normNumber(chNumber: string): string {
  // Strip ALL whitespace (not just the ends): a company number is contiguous, so "12 345 678"
  // and "12345678" are the same watch and must key identically, or a snapshot could be orphaned.
  return chNumber.replace(/\s+/g, "").toUpperCase();
}

function snapKey(tenantId: string, chNumber: string): string {
  return `${tenantId}::${normNumber(chNumber)}`;
}

export class InMemoryMonitorStore implements MonitorStore {
  private watchlists = new Map<string, Map<string, WatchEntry>>(); // tenantId -> chNumber -> entry
  private snapshots = new Map<string, Snapshot>(); // "tenant::number" -> latest snapshot
  private events = new Map<string, ChangeEvent[]>(); // tenantId -> events (append order)

  async addToWatchlist(tenantId: string, chNumber: string): Promise<void> {
    const num = normNumber(chNumber);
    const wl = this.watchlists.get(tenantId) ?? new Map<string, WatchEntry>();
    if (!wl.has(num)) wl.set(num, { chNumber: num, addedAt: new Date().toISOString() });
    this.watchlists.set(tenantId, wl);
  }

  async removeFromWatchlist(tenantId: string, chNumber: string): Promise<void> {
    const wl = this.watchlists.get(tenantId);
    if (wl) wl.delete(normNumber(chNumber));
    // The baseline goes with the watch. Kept, a company re-added months later was diffed against
    // it and every change since was reported as new today (WP-QA03 S2).
    this.snapshots.delete(snapKey(tenantId, chNumber));
  }

  async listWatchlist(tenantId: string): Promise<WatchEntry[]> {
    const wl = this.watchlists.get(tenantId);
    if (!wl) return [];
    // Newest first, then by number, so a tie on addedAt sorts the same way every time (WP-QA05).
    return [...wl.values()].sort((a, b) => cmp(b.addedAt, a.addedAt) || cmp(a.chNumber, b.chNumber));
  }

  async saveSnapshot(snapshot: Snapshot): Promise<void> {
    this.snapshots.set(snapKey(snapshot.tenantId, snapshot.chNumber), snapshot);
  }

  async loadSnapshot(tenantId: string, chNumber: string): Promise<Snapshot | null> {
    return this.snapshots.get(snapKey(tenantId, chNumber)) ?? null;
  }

  async recordEvents(events: ChangeEvent[]): Promise<void> {
    for (const e of events) {
      const list = this.events.get(e.tenantId) ?? [];
      // A keyed event already recorded for this tenant is the same movement seen by an
      // overlapping check (runCheck.ts eventKey); record it once.
      if (e.key !== undefined && list.some((x) => x.key === e.key)) continue;
      list.push(e);
      this.events.set(e.tenantId, list);
    }
  }

  async listEvents(tenantId: string, limit = 50): Promise<ChangeEvent[]> {
    const list = this.events.get(tenantId) ?? [];
    // Most-recent first, then capped. Ties on observedAt keep insertion order reversed.
    return [...list]
      .sort((a, b) => (a.observedAt < b.observedAt ? 1 : a.observedAt > b.observedAt ? -1 : 0))
      .slice(0, Math.max(0, limit));
  }

  async listTenantsWithWatches(): Promise<string[]> {
    return [...this.watchlists.entries()].filter(([, wl]) => wl.size > 0).map(([t]) => t);
  }
}

// Process-wide singleton, mirroring getStore()/getRateLimiter(). Routes and the cron sweep
// share this one instance so a watch added through the API is visible to the next re-check.
// A durable PostgresMonitorStore activates automatically once DATABASE_URL is set (its
// optional `postgres` client is loaded via a guarded dynamic import, so the in-memory default
// needs nothing installed); without a database, watches live for the life of the process.
// Hung off globalThis, not a module-level `let`: in Next.js dev each route is bundled
// separately, so a module-level singleton would differ per route and a watch added through
// /api/monitor would be invisible to the /watchlist page. globalThis is shared across every
// bundle in the one process. (With DATABASE_URL set the store is external, so this is moot.)
const globalStore = globalThis as unknown as { __monitorStore__?: MonitorStore };

export function getMonitorStore(): MonitorStore {
  if (!globalStore.__monitorStore__) {
    globalStore.__monitorStore__ = databaseUrl() ? new PostgresMonitorStore() : new InMemoryMonitorStore();
  }
  return globalStore.__monitorStore__;
}

// Whether the monitor store survives a restart (DATABASE_URL set). Surfaced so the UI can
// honestly say whether a watchlist is durable, mirroring storeIsDurable() for tear sheets.
export function monitorIsDurable(): boolean {
  return !!databaseUrl();
}

// Test / boundary helper: drop the state so a suite starts clean. Always resets to the
// in-memory store so unit tests never reach for a database.
export function resetMonitorStoreForTests(): void {
  globalStore.__monitorStore__ = new InMemoryMonitorStore();
}
