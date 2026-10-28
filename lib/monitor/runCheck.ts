// lib/monitor/runCheck.ts
// The re-check loop: fetch a fresh snapshot, diff it against the stored one, record the
// cited events, then save the fresh snapshot as the new baseline. Per-company fetch errors
// are swallowed and logged so one dead company (struck off, network blip, CH budget hit)
// never aborts a tenant's whole sweep. The first check of a company has no prior snapshot,
// so it emits nothing and simply establishes the baseline, which is honest: with nothing to
// compare against there is nothing observed to cite.
//
// Two checks of one company can overlap (the cron sweep and a manual re-check, on different
// instances). Both read the same stored baseline and see the same movements, so each event is
// keyed by that baseline (eventKey) and the store records a key once. A per-process lock would
// not reach across serverless instances; the key does, through the unique index in
// db/migrations/0012_change_event_key.sql (WP-QA05).

import { buildSnapshot } from "./snapshot";
import { diffSnapshots } from "./diff";
import type { MonitorStore } from "./store";
import type { ChangeEvent, Snapshot } from "./types";

// The same movement seen from the same baseline always gets the same key. The fresh snapshot's
// takenAt is left out on purpose: it differs between two overlapping checks.
export function eventKey(prev: Snapshot, e: ChangeEvent): string {
  return [prev.takenAt, e.kind, e.provenance.field, e.detail].join("|");
}

export interface CheckResult {
  chNumber: string;
  ok: boolean;
  events: ChangeEvent[];
  baseline: boolean; // true when this was the first snapshot (no diff possible)
  error?: string;
}

// Re-check one company for one tenant. Never throws: a fetch failure is captured in the
// result and logged, so a caller iterating a watchlist keeps going.
export async function runCheckOne(
  tenantId: string,
  chNumber: string,
  store: MonitorStore,
  build: (chNumber: string, tenantId: string) => Promise<Snapshot> = buildSnapshot,
): Promise<CheckResult> {
  try {
    const prev = await store.loadSnapshot(tenantId, chNumber);
    const next = await build(chNumber, tenantId);
    let events: ChangeEvent[] = [];
    if (prev) {
      events = diffSnapshots(prev, next).map((e) => ({ ...e, key: eventKey(prev, e) }));
      if (events.length > 0) await store.recordEvents(events);
    }
    // Save the fresh snapshot as the new baseline whether or not anything moved.
    await store.saveSnapshot(next);
    return { chNumber, ok: true, events, baseline: prev === null };
  } catch (e) {
    const error = (e as Error).message;
    // Log and swallow: one company's failure must not abort the sweep.
    console.error(`[monitor] re-check failed for ${chNumber} (tenant ${tenantId}): ${error}`);
    return { chNumber, ok: false, events: [], baseline: false, error };
  }
}

// Re-check every company on a tenant's watchlist, sequentially. Sequential (not Promise.all)
// so a large list drips through the shared Companies House budget guard rather than bursting
// against CH's 600-per-5-minutes ceiling all at once.
export async function runCheckForTenant(
  tenantId: string,
  store: MonitorStore,
): Promise<CheckResult[]> {
  const watchlist = await store.listWatchlist(tenantId);
  const results: CheckResult[] = [];
  for (const entry of watchlist) {
    results.push(await runCheckOne(tenantId, entry.chNumber, store));
  }
  return results;
}
