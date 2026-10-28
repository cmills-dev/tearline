// lib/run/store.ts
// The run persistence seam, mirroring lib/store/tearSheetStore.ts and lib/monitor/store.ts:
// one interface, an in-memory default and a durable Postgres adapter that activates when
// DATABASE_URL is set. Tenancy is a first-class argument on every method, so the MNPI wall
// has somewhere to stand: a run belongs to one desk and no other desk can load it.
//
// No Postgres exists on this deployment yet. db/migrations/0011_runs.sql is written and
// reviewed but not executed, and every test in the suite runs against the in-memory store,
// which is why the two implementations are held to the same three-method seam.
//
// The in-memory store is hung off globalThis rather than a module-level `let`, for the same
// reason the tear-sheet store is: in Next.js dev each route is bundled separately, so a run
// created through POST /api/run would otherwise be invisible to GET /api/run/[id].

import type { RunRecord } from "./types";
import { databaseUrl } from "../store/postgres";
import { PostgresRunStore } from "./postgres";

export interface RunStore {
  // Create or overwrite the whole record. The runner saves after every stage transition, so
  // an upsert of the whole row is the simplest thing that can be correct: there is exactly
  // one writer per run.
  save(run: RunRecord): Promise<void>;
  // null when this tenant has no run with that id. A run belonging to ANOTHER tenant reads as
  // null too, which is the point.
  load(tenantId: string, id: string): Promise<RunRecord | null>;
  // Most-recent first.
  list(tenantId: string, limit?: number): Promise<RunRecord[]>;
}

export const DEFAULT_LIST_LIMIT = 50;

export class InMemoryRunStore implements RunStore {
  private data = new Map<string, RunRecord>(); // "tenant::id" -> record

  private key(tenantId: string, id: string): string {
    return `${tenantId}::${id}`;
  }

  async save(run: RunRecord): Promise<void> {
    // Store a copy, not the runner's live object: the runner mutates its record between
    // saves, and a reader holding the same reference would see half-written states.
    this.data.set(this.key(run.tenantId, run.id), structuredClone(run));
  }

  async load(tenantId: string, id: string): Promise<RunRecord | null> {
    const found = this.data.get(this.key(tenantId, id));
    return found ? structuredClone(found) : null;
  }

  async list(tenantId: string, limit = DEFAULT_LIST_LIMIT): Promise<RunRecord[]> {
    return [...this.data.values()]
      .filter((r) => r.tenantId === tenantId)
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }
}

const g = globalThis as unknown as { __runStore__?: RunStore | null };

// The process store. Postgres once DATABASE_URL is set; in-memory otherwise. Constructing
// PostgresRunStore opens no connection and its optional `postgres` client is imported at
// runtime inside the first query, so the in-memory path pulls in nothing extra.
export function getRunStore(): RunStore {
  if (g.__runStore__) return g.__runStore__;
  g.__runStore__ = databaseUrl() ? new PostgresRunStore() : new InMemoryRunStore();
  return g.__runStore__;
}

// Whether a run survives a restart. The GET route says so honestly, because on the in-memory
// store a cold start loses every run in flight and a poller deserves to know that is possible.
export function runsAreDurable(): boolean {
  return !!databaseUrl();
}

// Test / boundary helper: drop the memoised store so a suite starts clean.
export function resetRunStoreForTests(): void {
  g.__runStore__ = null;
}
