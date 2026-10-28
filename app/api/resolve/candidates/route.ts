// app/api/resolve/candidates/route.ts
// GET ?q=<text>: the register candidates for a name, without starting a run (WP-FE02).
//
// The run entry calls this first for anything that is not a Companies House number, shows the
// answer as a pick list, and runs only the company picked, by its number. The work is the
// resolver alone (lib/resolve/candidates.ts): up to 1 search, 8 profiles and 3 filing histories
// of the register's 600 per 5 minutes. No run record, no document fetch, no model call.
//
// Errors match POST /api/run so the entry reads both the same way. A tenant is required even
// though nothing tenant-scoped is read, so an anonymous caller cannot spend the register budget,
// and the throttle has buckets of its own so a lookup never spends a run.

import { NextResponse } from "next/server";
import { ipOf, LIMITS, throttle } from "@/lib/http/limit";
import { getTenantId } from "@/lib/tenant";
import { createResolveClient } from "@/lib/resolve/chClient";
import { candidatesAnswer } from "@/lib/resolve/candidates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_INPUT = 200;

export async function GET(req: Request) {
  const tenantId = await getTenantId();
  if (!tenantId) return NextResponse.json({ error: "You must be signed in." }, { status: 401 });

  const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
  if (!q) {
    return NextResponse.json({ error: "Type a company name or a Companies House number." }, { status: 400 });
  }
  if (q.length > MAX_INPUT) {
    return NextResponse.json({ error: "That is too long for a company name or number." }, { status: 400 });
  }

  if (!process.env.CH_API_KEY) {
    return NextResponse.json(
      { error: "A lookup needs CH_API_KEY (free from Companies House). Without it nothing can be looked up." },
      { status: 503 },
    );
  }

  const limited = await throttle([
    { bucket: "resolve:tenant", id: tenantId, ...LIMITS.resolvePerTenant },
    { bucket: "resolve:ip", id: ipOf(req), ...LIMITS.resolvePerIp },
  ]);
  if (limited) return limited;

  try {
    return NextResponse.json(await candidatesAnswer(q, createResolveClient()), {
      headers: { "cache-control": "no-store" },
    });
  } catch {
    // A register failure is not a no-match. The entry shows this as unavailable.
    return NextResponse.json(
      { error: "Companies House did not answer. Try again in a minute." },
      { status: 502 },
    );
  }
}
