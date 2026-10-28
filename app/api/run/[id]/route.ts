// app/api/run/[id]/route.ts
// What a poller reads. Returns the stages, how long the run has taken, any abstentions, and
// once the run is done, the sheet key to open.
//
// A reload mid-run shows where the run is, because the record is written on every stage
// transition rather than at the end. That is what makes the front end's job a poll and not a
// held-open connection.
//
// Tenant-scoped: the store is asked for (tenantId, id), so a run belonging to another desk
// reads as absent. A 404 is the right answer there, not a 403: telling a caller that an id
// exists but is not theirs is itself a leak.

import { NextResponse } from "next/server";
import { getTenantId } from "@/lib/tenant";
import { getRunStore, runsAreDurable } from "@/lib/run/store";
import { runView } from "@/lib/run/view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const tenantId = await getTenantId();
  if (!tenantId) return NextResponse.json({ error: "You must be signed in." }, { status: 401 });

  const { id } = await params;
  const run = await getRunStore().load(tenantId, id);
  if (!run) {
    return NextResponse.json(
      {
        error: "No such run.",
        // Worth saying plainly: without DATABASE_URL a run lives in one instance's memory, so
        // a cold start or a second instance loses it. This is the honest explanation for the
        // most likely cause of a 404 on an id the caller definitely just received.
        note: runsAreDurable()
          ? undefined
          : "Runs are held in memory on this deployment, so a restart loses them. Set DATABASE_URL and apply db/migrations/0011_runs.sql to make them durable.",
      },
      { status: 404 },
    );
  }

  return NextResponse.json(runView(run, runsAreDurable()));
}
