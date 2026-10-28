// app/api/monitor/route.ts
// Tenant-scoped monitoring control surface. POST { action } dispatched on:
//   add    { chNumber }  - add a company to this tenant's watchlist
//   remove { chNumber }  - drop a company from the watchlist
//   run                  - re-check the whole watchlist now (needs CH_API_KEY)
//   list                 - the watchlist plus recent cited change events
// Returns 401 when there is no tenant. `run` needs CH_API_KEY for the live register; without
// it we return a graceful note rather than crashing, exactly like /api/originate.

import { NextResponse } from "next/server";
import { readJsonObject, textField } from "@/lib/http/body";
import { getTenantId } from "@/lib/tenant";
import { getMonitorStore } from "@/lib/monitor/store";
import { runCheckForTenant } from "@/lib/monitor/runCheck";

export const dynamic = "force-dynamic";

// The recent-events cap returned to the UI. Kept small so the panel stays readable.
const RECENT_EVENTS = 50;

// A Companies House company number is 8 characters: 8 digits, or a 2-letter prefix (SC, NI, OC,
// AP, ...) then 6 digits. We accept 6-10 alphanumerics to tolerate historical/edge formats but
// reject anything else, so an oversized or injected string never reaches the store or the fetcher.
const CH_NUMBER_RE = /^[A-Za-z0-9]{6,10}$/;

// A per-tenant watchlist cap. Each watched company costs c. 4 Companies House calls per sweep, so
// an unbounded watchlist is a lever to drain the shared CH budget; this bounds a tenant's fan-out.
const MAX_WATCHLIST = 200;

async function snapshotOfTenant(tenantId: string) {
  const store = getMonitorStore();
  const [watchlist, events] = await Promise.all([
    store.listWatchlist(tenantId),
    store.listEvents(tenantId, RECENT_EVENTS),
  ]);
  return { watchlist, events };
}

export async function POST(req: Request) {
  const tenantId = await getTenantId();
  if (!tenantId) return NextResponse.json({ error: "You must be signed in." }, { status: 401 });

  const body = (await readJsonObject(req)) as { action?: string; chNumber?: string };
  const action = textField(body.action).trim();
  const chNumber = textField(body.chNumber).trim();
  const store = getMonitorStore();

  switch (action) {
    case "add": {
      if (!chNumber) return NextResponse.json({ error: "chNumber required" }, { status: 400 });
      if (!CH_NUMBER_RE.test(chNumber)) {
        return NextResponse.json({ error: "chNumber must be a Companies House number (6-10 alphanumeric characters)." }, { status: 400 });
      }
      const current = await store.listWatchlist(tenantId);
      const already = current.some((w) => w.chNumber.toUpperCase() === chNumber.toUpperCase());
      if (!already && current.length >= MAX_WATCHLIST) {
        return NextResponse.json({ error: `Watchlist is capped at ${MAX_WATCHLIST} companies. Remove one before adding another.` }, { status: 400 });
      }
      await store.addToWatchlist(tenantId, chNumber);
      return NextResponse.json(await snapshotOfTenant(tenantId));
    }

    case "remove": {
      if (!chNumber) return NextResponse.json({ error: "chNumber required" }, { status: 400 });
      await store.removeFromWatchlist(tenantId, chNumber);
      return NextResponse.json(await snapshotOfTenant(tenantId));
    }

    case "run": {
      if (!process.env.CH_API_KEY) {
        // Graceful, not a crash: the watchlist still returns so the desk sees its state.
        return NextResponse.json({
          ...(await snapshotOfTenant(tenantId)),
          note: "Re-check needs CH_API_KEY (free from Companies House). Watchlist shown, no fresh check run.",
        });
      }
      const results = await runCheckForTenant(tenantId, store);
      const found = results.reduce((n, r) => n + r.events.length, 0);
      return NextResponse.json({
        ...(await snapshotOfTenant(tenantId)),
        checked: results.length,
        changesFound: found,
        results,
      });
    }

    case "list":
    case "": {
      return NextResponse.json(await snapshotOfTenant(tenantId));
    }

    default:
      return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  }
}
