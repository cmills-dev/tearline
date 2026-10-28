// lib/store/tearSheetStore.ts
// The persistence seam. Everything the product produces is a FactManifest; this is the
// one interface through which manifests are saved and read back, keyed by TENANT and a
// record key. Tenancy is a first-class argument on every call, not an afterthought, so
// the MNPI wall has somewhere to stand from day one (a Postgres implementation enforces
// it with row-level security; see db/migrations/0001_init.sql).
//
// A manifest is validated against the frozen contract BEFORE it is stored, so a
// contract-violating record can never be written. The default implementation is
// in-memory (per-process, not durable) - it keeps the interface exercised and the demo
// working with no database. A durable Postgres implementation activates when DATABASE_URL
// is set and its adapter is provided (see db/README.md).

import type { FactManifest } from "../engine/types";
import { CONTRACT_VERSION } from "../contracts";
import { validateFactManifest } from "../contracts/validate";
import { PostgresTearSheetStore, databaseUrl } from "./postgres";

export interface StoredTearSheet {
  tenantId: string;
  key: string;
  contractVersion: string; // the contract version the record was written under
  manifest: FactManifest;
  savedAt: string; // ISO
}

export interface StoredRef {
  tenantId: string;
  key: string;
  companyName: string;
  synthetic: boolean;
  savedAt: string;
}

export interface TearSheetStore {
  save(tenantId: string, key: string, manifest: FactManifest): Promise<void>;
  load(tenantId: string, key: string): Promise<FactManifest | null>;
  list(tenantId: string): Promise<StoredRef[]>;
}

// Guard shared by every implementation: never persist a manifest that fails the frozen
// contract. Throws with the first few concrete problems.
export function assertPersistable(manifest: FactManifest): void {
  const v = validateFactManifest(manifest);
  if (!v.ok) {
    throw new Error(
      `Refusing to persist a manifest that violates contract ${CONTRACT_VERSION}: ${v.errors
        .slice(0, 3)
        .join("; ")}`
    );
  }
}

export class InMemoryTearSheetStore implements TearSheetStore {
  private data = new Map<string, StoredTearSheet>();

  private id(tenantId: string, key: string): string {
    return `${tenantId}::${key}`;
  }

  async save(tenantId: string, key: string, manifest: FactManifest): Promise<void> {
    assertPersistable(manifest);
    this.data.set(this.id(tenantId, key), {
      tenantId,
      key,
      contractVersion: CONTRACT_VERSION,
      manifest,
      savedAt: new Date().toISOString(),
    });
  }

  async load(tenantId: string, key: string): Promise<FactManifest | null> {
    return this.data.get(this.id(tenantId, key))?.manifest ?? null;
  }

  async list(tenantId: string): Promise<StoredRef[]> {
    return [...this.data.values()]
      .filter((s) => s.tenantId === tenantId)
      .map((s) => ({
        tenantId: s.tenantId,
        key: s.key,
        companyName: s.manifest.entity.companyName,
        synthetic: s.manifest.entity.synthetic,
        savedAt: s.savedAt,
      }));
  }
}

// Hung off globalThis, not a module-level `let`: in Next.js dev each route is bundled separately,
// so a module-level singleton would differ per bundle and a sheet saved through one route would be
// invisible to another. globalThis is shared across every bundle in the one process. (With
// DATABASE_URL set the store is external, so this is moot.)
const g = globalThis as unknown as { __tearSheetStore__?: TearSheetStore | null };

// Returns the process store. A durable Postgres store activates here once DATABASE_URL is
// set: PostgresTearSheetStore (lib/store/postgres.ts) implements the same three methods
// against the 0001 migration and loads the `postgres` client via a guarded dynamic import,
// so this module has no static dependency on it and the in-memory default needs nothing
// installed. With no DATABASE_URL, records live in memory for the life of the process,
// which is enough to exercise the seam and keep the demo self-contained.
//
// The require is lazy (inside the branch) so a build / runtime without DATABASE_URL never
// touches the Postgres adapter, and the singleton is memoised so one client / one Map is
// reused across calls within an instance.
export function getStore(): TearSheetStore {
  if (g.__tearSheetStore__) return g.__tearSheetStore__;
  // The Postgres adapter is imported statically, but constructing it opens no connection
  // and its optional `postgres` client is only imported at runtime inside the first query
  // (see lib/store/postgres.ts). So the in-memory default path pulls in nothing extra.
  g.__tearSheetStore__ = databaseUrl()
    ? new PostgresTearSheetStore()
    : new InMemoryTearSheetStore();
  return g.__tearSheetStore__;
}

// Whether a durable store is configured. Surfaced so the UI can honestly say whether a
// record will survive a restart. Reflects DATABASE_URL: with it set, saves land in
// Postgres and survive a restart; without it, records are per-process only.
export function storeIsDurable(): boolean {
  return !!databaseUrl();
}

// Test / boundary helper: drop the memoised store so a suite can re-read the env.
export function resetStoreForTests(): void {
  g.__tearSheetStore__ = null;
}
