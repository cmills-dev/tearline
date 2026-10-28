// app/api/cron/monitor/route.ts
// The scheduled sweep: re-check every tenant's watchlist on a timer. Guarded so only an
// authorised caller can trigger a fleet-wide re-check.
//
// AUTHORISATION - two accepted callers, nothing else:
//   1. Vercel Cron. When CRON_SECRET is set in the project env, Vercel sends it as
//      `Authorization: Bearer <CRON_SECRET>` on the scheduled request. Set CRON_SECRET and
//      this matches. (Vercel also stamps an `x-vercel-cron` header on genuine cron calls,
//      which we accept when no secret is configured, e.g. a preview deploy.)
//   2. A manual operator call presenting the same bearer secret.
// Any other caller gets 401. The schedule itself lives in vercel.json (crons entry pointing
// at /api/cron/monitor). Without CH_API_KEY the sweep runs but every fetch abstains, so it
// is a no-op rather than a crash.

import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { getMonitorStore } from "@/lib/monitor/store";
import { runCheckForTenant } from "@/lib/monitor/runCheck";

export const dynamic = "force-dynamic";

// Constant-time string comparison so a bearer-secret check cannot be probed by timing.
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function authorised(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    return safeEqual(req.headers.get("authorization") ?? "", `Bearer ${secret}`);
  }
  // No secret configured: accept Vercel's own cron header so the scheduled job still runs on
  // a deploy where CRON_SECRET has not been set. A public caller carries neither. (In production
  // the prod-guard requires CRON_SECRET, so this fallback only applies in dev/preview.)
  return req.headers.get("x-vercel-cron") !== null;
}

async function sweep(req: Request) {
  if (!authorised(req)) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const store = getMonitorStore();
  const tenants = await store.listTenantsWithWatches();

  let companiesChecked = 0;
  let changesFound = 0;
  for (const tenantId of tenants) {
    const results = await runCheckForTenant(tenantId, store);
    companiesChecked += results.length;
    changesFound += results.reduce((n, r) => n + r.events.length, 0);
  }

  return NextResponse.json({
    ok: true,
    tenantsSwept: tenants.length,
    companiesChecked,
    changesFound,
    ranWithLiveData: Boolean(process.env.CH_API_KEY),
    sweptAt: new Date().toISOString(),
  });
}

// Vercel Cron issues a GET. POST is accepted too for a manual operator trigger.
export async function GET(req: Request) {
  return sweep(req);
}

export async function POST(req: Request) {
  return sweep(req);
}
