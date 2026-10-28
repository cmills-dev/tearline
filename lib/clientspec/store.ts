// lib/clientspec/store.ts
// The persistence seam for per-tenant ClientSpecs (versioned) and onboarding state, mirroring
// lib/store/shortlistStore.ts. A tenant accumulates a monotonic history of induced ClientSpecs
// plus one OnboardingState tracking wizard progress and the active spec pointer. Tenancy is a
// first-class argument on every call. The default is in-memory (per-process, not durable); a
// durable PostgresClientSpecStore activates when DATABASE_URL is set
// (db/migrations/0006_clientspec.sql), loaded via a guarded dynamic import so the in-memory
// default needs nothing installed.

import type { ClientSpec, ClientSpecStore, ClientSynonym, FeedbackEvent, OnboardingState } from "./types";
import { emptyOnboardingState } from "./types";
import { databaseUrl } from "../store/postgres";
import { PostgresClientSpecStore } from "./postgres";

export class InMemoryClientSpecStore implements ClientSpecStore {
  private specsByTenant = new Map<string, ClientSpec[]>();
  private stateByTenant = new Map<string, OnboardingState>();
  // RSI Phase 1: learned synonyms (keyed by labelNorm) and the append-only feedback trail, per
  // tenant. Same shape as specsByTenant/stateByTenant so tenancy stays a Map key, never leaks.
  private synonymsByTenant = new Map<string, Map<string, ClientSynonym>>();
  private feedbackByTenant = new Map<string, FeedbackEvent[]>();

  async saveSpec(tenantId: string, spec: ClientSpec): Promise<number> {
    const existing = this.specsByTenant.get(tenantId) ?? [];
    // Next version is the max version this tenant has ever saved, plus one (so the first
    // spec is version 1). The spec's own `version` field is overwritten with it.
    const version = existing.reduce((max, s) => Math.max(max, s.version), 0) + 1;
    const record: ClientSpec = { ...spec, version };
    this.specsByTenant.set(tenantId, [...existing, record]);
    return version;
  }

  async listSpecs(tenantId: string): Promise<ClientSpec[]> {
    const list = this.specsByTenant.get(tenantId) ?? [];
    return [...list].sort((a, b) => b.version - a.version);
  }

  async getActiveSpec(tenantId: string): Promise<ClientSpec | null> {
    const state = await this.getState(tenantId);
    if (state.activeSpecVersion === null) return null;
    const list = this.specsByTenant.get(tenantId) ?? [];
    return list.find((s) => s.version === state.activeSpecVersion) ?? null;
  }

  async setActiveSpec(tenantId: string, version: number): Promise<void> {
    const state = await this.getState(tenantId);
    await this.setState(tenantId, { ...state, activeSpecVersion: version });
  }

  async getState(tenantId: string): Promise<OnboardingState> {
    return this.stateByTenant.get(tenantId) ?? emptyOnboardingState(tenantId);
  }

  async setState(tenantId: string, state: OnboardingState): Promise<void> {
    this.stateByTenant.set(tenantId, { ...state, updatedAt: new Date().toISOString() });
  }

  async addSynonym(tenantId: string, syn: ClientSynonym): Promise<void> {
    let byLabel = this.synonymsByTenant.get(tenantId);
    if (!byLabel) {
      byLabel = new Map<string, ClientSynonym>();
      this.synonymsByTenant.set(tenantId, byLabel);
    }
    // Upsert by labelNorm: latest write wins, overwriting the concept, source label and time.
    byLabel.set(syn.labelNorm, { ...syn });
  }

  async listSynonyms(tenantId: string): Promise<ClientSynonym[]> {
    const byLabel = this.synonymsByTenant.get(tenantId);
    return byLabel ? [...byLabel.values()] : [];
  }

  async recordFeedback(tenantId: string, event: FeedbackEvent): Promise<void> {
    const list = this.feedbackByTenant.get(tenantId) ?? [];
    // Append-only; pin the tenant defensively so an event can never carry another's id.
    list.push({ ...event, tenantId });
    this.feedbackByTenant.set(tenantId, list);
  }

  async listFeedback(tenantId: string, limit = 50): Promise<FeedbackEvent[]> {
    const list = this.feedbackByTenant.get(tenantId) ?? [];
    // Newest first, capped at limit.
    return [...list].reverse().slice(0, limit);
  }
}

// The singleton is hung off globalThis, not a module-level `let`. In Next.js dev each route
// is bundled separately, so a module-level singleton would be a DIFFERENT instance per route,
// and an in-memory spec saved by /api/onboarding/activate would be invisible to
// /api/onboarding/housesheet. globalThis is shared across every bundle in the one process, so
// all routes share the same in-memory store, exactly as they will share one Postgres store in
// production. (With DATABASE_URL set this is moot; the store is external either way.)
const globalStore = globalThis as unknown as { __clientSpecStore__?: ClientSpecStore };

// Returns the process ClientSpec store. A durable Postgres store activates once DATABASE_URL
// is set; without it, specs and onboarding state live in memory for the life of the process.
export function getClientSpecStore(): ClientSpecStore {
  if (!globalStore.__clientSpecStore__) {
    globalStore.__clientSpecStore__ = databaseUrl() ? new PostgresClientSpecStore() : new InMemoryClientSpecStore();
  }
  return globalStore.__clientSpecStore__;
}

// Whether the store survives a restart (DATABASE_URL set). Surfaced so the UI can honestly
// say whether a spec or onboarding state is durable, mirroring storeIsDurable() for tear
// sheets and monitorIsDurable() for watchlists.
export function clientSpecIsDurable(): boolean {
  return !!databaseUrl();
}

// Test / boundary helper: drop the state so a suite starts clean (always in-memory).
export function resetClientSpecStoreForTests(): void {
  globalStore.__clientSpecStore__ = new InMemoryClientSpecStore();
}
