// lib/store/shortlistStore.ts
// The persistence seam for origination shortlists, mirroring tearSheetStore.ts. A saved
// shortlist is a whole OriginationSuggestion plus the moment it was saved; it does not fit
// the frozen FactManifest contract, so it lives on its own seam rather than in the tear-sheet
// store. Tenancy is a first-class argument on every call. The default is in-memory
// (per-process, not durable); a durable PostgresShortlistStore activates when DATABASE_URL is
// set (db/migrations/0005_monitor.sql), loaded via a guarded dynamic import so the in-memory
// default needs nothing installed.

import type { OriginationSuggestion } from "../originate/suggestion";
import { databaseUrl } from "./postgres";
import { PostgresShortlistStore } from "./shortlistPostgres";

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export type SavedSuggestion = OriginationSuggestion & { savedAt: string };

export interface ShortlistStore {
  // Save (or replace, by target) a suggestion for the tenant. Returns the stored record.
  save(tenantId: string, suggestion: OriginationSuggestion): Promise<SavedSuggestion>;
  // Every shortlist the tenant has saved, most-recent first. Invisible to other tenants.
  list(tenantId: string): Promise<SavedSuggestion[]>;
}

// A stable id for a suggestion: its target, so re-saving the same target overwrites rather
// than duplicates. Shared by both implementations so keys agree across the flip.
export function suggestionId(s: Pick<OriginationSuggestion, "target">): string {
  return s.target.chNumber || s.target.nodeId || s.target.name;
}

export class InMemoryShortlistStore implements ShortlistStore {
  private byTenant = new Map<string, SavedSuggestion[]>();

  async save(tenantId: string, suggestion: OriginationSuggestion): Promise<SavedSuggestion> {
    const record: SavedSuggestion = { ...suggestion, savedAt: new Date().toISOString() };
    const id = suggestionId(suggestion);
    const existing = this.byTenant.get(tenantId) ?? [];
    const next = existing.filter((r) => suggestionId(r) !== id);
    next.push(record);
    this.byTenant.set(tenantId, next);
    return record;
  }

  async list(tenantId: string): Promise<SavedSuggestion[]> {
    const list = this.byTenant.get(tenantId) ?? [];
    // Newest first, then by id, so a tie on savedAt sorts the same way every time (WP-QA05).
    return [...list].sort((a, b) => cmp(b.savedAt, a.savedAt) || cmp(suggestionId(a), suggestionId(b)));
  }
}

// Hung off globalThis, not a module-level `let`: in Next.js dev each route is bundled
// separately, so a module-level singleton would differ per route and a shortlist saved through
// one route would be invisible to another. globalThis is shared across every bundle in the one
// process. (With DATABASE_URL set the store is external, so this is moot.)
const globalStore = globalThis as unknown as { __shortlistStore__?: ShortlistStore };

// Returns the process shortlist store. A durable Postgres store activates once DATABASE_URL
// is set; without it, shortlists live in memory for the life of the process.
export function getShortlistStore(): ShortlistStore {
  if (!globalStore.__shortlistStore__) {
    globalStore.__shortlistStore__ = databaseUrl() ? new PostgresShortlistStore() : new InMemoryShortlistStore();
  }
  return globalStore.__shortlistStore__;
}

// Test / boundary helper: drop the state so a suite starts clean (always in-memory).
export function resetShortlistStoreForTests(): void {
  globalStore.__shortlistStore__ = new InMemoryShortlistStore();
}
