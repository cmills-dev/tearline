// lib/workspace.ts
// The tenant workspace: the seam between the app and the persistence store. Every
// function takes an explicit tenantId (resolved from the request in lib/tenant.ts),
// so this module is pure and unit-testable with no request context. It is the ONE
// place the product's save/list/load loop lives; routes call these, never the store
// directly.
//
// getTearSheet is the real load path: on first view it generates the manifest and
// saves it under the tenant; on later views it reads the saved manifest back and
// assembles from that. So a tear sheet becomes a durable, tenant-scoped record, not
// a value recomputed every request.
//
// Two kinds of record live here:
//   1. TEAR SHEETS - persisted as a FactManifest through the tearSheetStore seam
//      (contract-validated). Fixture-keyed sheets re-assemble from their bundled
//      fixture; source sheets (SEC / live / ESEF) re-assemble from a minimal fixture
//      derived from the saved manifest, so they reopen with no fixture on file.
//   2. ORIGINATION SHORTLISTS - a saved OriginationSuggestion. These do NOT fit the
//      FactManifest contract, so they live in a parallel typed collection rather than
//      being forced through the manifest store.

import type { TearSheet } from "./engine/assemble";
import { assembleTearSheet } from "./engine/assemble";
import type { BorrowerFixture, PeriodMeta } from "./sources/fixtures/types";
import type { FactManifest } from "./engine/types";
import type { OriginationSuggestion } from "./originate/suggestion";
import { assembleFromManifest, manifestForKey } from "./engine/pipeline";
import { getStore, storeIsDurable, type StoredRef } from "./store/tearSheetStore";
import {
  getShortlistStore,
  resetShortlistStoreForTests,
  type SavedSuggestion,
} from "./store/shortlistStore";

export interface ResolvedSheet {
  ts: TearSheet;
  fromStore: boolean; // true if the manifest was read back from the store
  durable: boolean; // true if the store survives a restart (DATABASE_URL set)
}

// Load-or-generate, scoped to the tenant. Returns null if the key is unknown.
export async function getTearSheet(tenantId: string, key: string): Promise<ResolvedSheet | null> {
  const store = getStore();
  let manifest = await store.load(tenantId, key);
  const fromStore = manifest !== null;
  if (!manifest) {
    // Only fixture-keyed sheets can be generated on demand. A source sheet (SEC / live /
    // ESEF) is persisted by its route; if it is not in the store, it is genuinely unknown.
    manifest = manifestForKey(key);
    if (!manifest) return null;
    await store.save(tenantId, key, manifest);
  }
  // Prefer the keyed fixture (fixture-backed demo sheets); fall back to a minimal fixture
  // derived from the manifest for source sheets that carry no bundled fixture.
  const ts = assembleFromManifest(key, manifest) ?? assembleTearSheet(manifest, fixtureFromManifest(manifest));
  return ts ? { ts, fromStore, durable: storeIsDurable() } : null;
}

// Explicitly persist a key for the tenant (idempotent; overwrites by key). Fixture-keyed.
export async function saveSheet(tenantId: string, key: string): Promise<boolean> {
  const manifest = manifestForKey(key);
  if (!manifest) return false;
  await getStore().save(tenantId, key, manifest);
  return true;
}

// Persist an already-assembled source manifest (SEC / live / ESEF) under a stable key.
// Contract validation happens inside the store; callers use this fire-and-forget so a
// save failure never breaks a render.
export async function saveManifest(tenantId: string, key: string, manifest: FactManifest): Promise<void> {
  await getStore().save(tenantId, key, manifest);
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// Everything the tenant has saved (tear sheets), most-recent first.
export async function listWorkspace(tenantId: string): Promise<StoredRef[]> {
  const refs = await getStore().list(tenantId);
  // Newest first; two sheets saved in the same instant fall back to their key, so the order is
  // the same on every call (a comparator must return 0 on a tie; WP-QA05).
  return refs.sort((a, b) => cmp(b.savedAt, a.savedAt) || cmp(a.key, b.key));
}

// A stable, URL-safe workspace key for a source sheet. Prefixed by source so it never
// collides with a fixture key, and slugified so it survives a path segment unchanged.
export function sourceKey(source: "sec" | "esef" | "ch", manifest: FactManifest): string {
  const ident =
    manifest.entity.lei || manifest.entity.companyNumber || manifest.entity.companyName;
  return `${source}-${slug(ident)}`;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "record";
}

// Derive a minimal BorrowerFixture from a saved manifest. assembleTearSheet reads only
// periods, thesis and capitalStructure off the fixture, so a source sheet with no bundled
// fixture reopens faithfully from the stored facts alone.
export function fixtureFromManifest(manifest: FactManifest): BorrowerFixture {
  const periodKeys = [...new Set(Object.values(manifest.facts).map((f) => f.period))].filter(
    (p) => p.length > 0,
  );
  const periods: PeriodMeta[] = (periodKeys.length ? periodKeys : ["FY"]).map((key) => ({
    key,
    label: key,
    end: periodEnd(key, manifest.entity.latestPeriodEnd),
    isLatest: false,
  }));
  periods.sort((a, b) => (a.end < b.end ? -1 : a.end > b.end ? 1 : 0));
  if (periods.length) periods[periods.length - 1].isLatest = true;

  const primaryKey = periods.find((p) => p.isLatest)?.key ?? periods[0]?.key ?? "";
  const hasDebt = !!manifest.facts[`borrowings.${primaryKey}`]?.value;

  // A Companies House manifest carries its secured debt as one fact per registered charge
  // (metric `charge<n>`), not a single `borrowings` line. Reconstruct one tranche per charge so a
  // reopened CH sheet shows the SAME capital structure as its first view, instead of an empty
  // block. Names are kept generic (the chargee names are not carried on the fact), which is
  // honest: the tranche count and provenance come from the stored facts, nothing is invented.
  const chargeMetrics = [
    ...new Set(
      Object.values(manifest.facts)
        .filter((f) => /^charge\d+$/.test(f.metric))
        .map((f) => f.metric),
    ),
  ].sort((a, b) => (a.length - b.length) || cmp(a, b));

  // No rank and no fulcrum: the charges register records security, not ranking (audit finding 7,
  // WP-BE16), so a reopened sheet claims no more than its first view did.
  const capitalStructure = chargeMetrics.length
    ? chargeMetrics.map((metric) => ({
        id: metric,
        name: "Registered charge",
        rank: "not-stated" as const,
        metric,
        security: "Registered charge (Companies House)",
        provider: "Registered chargee",
        isFulcrum: false,
      }))
    : hasDebt
      ? [
          {
            id: "total-debt",
            name: "Total debt (per balance sheet)",
            rank: "not-stated" as const,
            metric: "borrowings",
            security: "Consolidated debt as stored in the fact manifest",
            provider: "Various",
            isFulcrum: false,
          },
        ]
      : [];

  return {
    key: `stored-${slug(manifest.entity.companyNumber || manifest.entity.companyName)}`,
    displayName: manifest.entity.companyName,
    thesis:
      "Saved tear sheet, reloaded from your workspace. Every figure resolves from the stored fact manifest with its original provenance and resolution rung.",
    profile: {
      company_name: manifest.entity.companyName,
      company_number: manifest.entity.companyNumber,
      company_status: manifest.entity.status,
      date_of_creation: manifest.entity.incorporatedOn,
      type: manifest.entity.accountsType,
      jurisdiction: manifest.entity.jurisdiction,
      sic_codes: manifest.entity.sicCodes,
    },
    filingHistory: { items: [], total_count: 0 },
    charges: { items: [], total_count: 0 },
    sources: manifest.sources,
    periods,
    reported: [],
    capitalStructure,
    derivedMetrics: [],
  };
}

// A sortable ISO-ish period end. FYyyyy -> yyyy-12-31; otherwise fall back to the entity's
// latest period end, else the key itself. Used only to order period columns.
function periodEnd(periodKey: string, latestPeriodEnd: string): string {
  const m = periodKey.match(/(\d{4})/);
  if (m) return `${m[1]}-12-31`;
  return latestPeriodEnd || periodKey;
}

// ---------------------------------------------------------------------------
// Origination shortlists (a parallel typed collection, tenant-scoped)
// ---------------------------------------------------------------------------
// A saved OriginationSuggestion plus the moment it was saved. Suggestions do not fit the
// frozen FactManifest contract, so they live on their own persistence seam
// (lib/store/shortlistStore.ts), not through the manifest store. That seam is in-memory by
// default and durable (Postgres, db/migrations/0005_monitor.sql) once DATABASE_URL is set,
// exactly like the tear-sheet store, so a saved shortlist now survives a restart.

export type { SavedSuggestion };

// Save (or replace, by target) a suggestion for the tenant. Returns the stored record.
export async function saveSuggestion(
  tenantId: string,
  suggestion: OriginationSuggestion,
): Promise<SavedSuggestion> {
  return getShortlistStore().save(tenantId, suggestion);
}

// Every shortlist the tenant has saved, most-recent first. Invisible to other tenants.
export async function listSuggestions(tenantId: string): Promise<SavedSuggestion[]> {
  return getShortlistStore().list(tenantId);
}

// Test / boundary helper: drop the shortlists so a suite starts clean.
export function resetSuggestionsForTests(): void {
  resetShortlistStoreForTests();
}

export { storeIsDurable };
