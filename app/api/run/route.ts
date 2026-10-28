// app/api/run/route.ts
// POST a name or a Companies House number, get a run id back at once.
//
// The two halves of this file are the whole point of WP-BE06.
//
//   THE REQUEST HALF writes a `running` record and answers. It touches no register, no
//   document API and no model, so it returns in milliseconds rather than in the 35 to 50
//   seconds a scanned filing takes to read. The acceptance is two seconds; this is not close
//   to it, by construction rather than by tuning.
//
//   THE WORK HALF is handed to after() from next/server. after() runs the callback in the SAME
//   invocation once the response has been flushed, so the function stays alive and the run
//   keeps writing its stages to the store while the front end polls GET /api/run/[id].
//
// maxDuration lives in THIS FILE, not in vercel.json. A route segment config is read by the
// framework at build time and travels with the route; a vercel.json entry is matched by path
// and silently does nothing if the path is ever wrong. 300 seconds is the ceiling the platform
// allows the run; the run's own budget is 120 (lib/run/runner.ts), so it gives up on its own
// terms with a written reason long before the platform gives up on it without one.

import { NextResponse } from "next/server";
import { readJsonObject, textField } from "@/lib/http/body";
import { ipOf, LIMITS, throttle } from "@/lib/http/limit";
import { after } from "next/server";
import { getTenantId } from "@/lib/tenant";
import { createRun, executeRun, type RunDeps } from "@/lib/run/runner";
import { isLiveModeEnabled } from "@/lib/sources/companiesHouse";
import { buildFixtureManifest, fixtureForInput, FixtureRegisterClient } from "@/lib/run/fixtureRun";
import { runsAreDurable } from "@/lib/run/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_INPUT = 200;

interface RunBody {
  // A company name or a Companies House number. One field, because the resolver classifies
  // the input itself (lib/resolve/numbers.ts) and asking the user which it is would be asking
  // them to do the product's job.
  input?: string;
  query?: string; // accepted as an alias, so a caller need not guess the field name
}

export async function POST(req: Request) {
  const tenantId = await getTenantId();
  if (!tenantId) return NextResponse.json({ error: "You must be signed in." }, { status: 401 });

  const body = (await readJsonObject(req)) as RunBody;
  const input = (textField(body.input) || textField(body.query)).trim();
  if (!input) {
    return NextResponse.json(
      { error: "Type a company name or a Companies House number." },
      { status: 400 },
    );
  }

  if (input.length > MAX_INPUT) {
    // The longest name on the register is 160 characters; anything past this is not a name.
    return NextResponse.json({ error: "That is too long for a company name or number." }, { status: 400 });
  }

  // Every run can reach the register, the document API and a paid scan read. Throttled per desk
  // and per IP, because an anonymous tenant is one cookie away from a fresh one (WP-QA03).
  const limited = await throttle([
    { bucket: "run:tenant", id: tenantId, ...LIMITS.runPerTenant },
    { bucket: "run:ip", id: ipOf(req), ...LIMITS.runPerIp },
  ]);
  if (limited) return limited;

  // With no CH_API_KEY the app is in fixtures mode (dataMode "fixtures"). A run then reaches only
  // the bundled illustrative borrowers, on the same stages and store, so the local preview and
  // the smoke export check work without a key (WP-QA05). Any other input still gets the graceful
  // 503 /api/pipeline gives: a missing free key is a setup gap, not a server error, and it must
  // not create a run that can only ever fail.
  const live = isLiveModeEnabled();
  if (!live && !fixtureForInput(input)) {
    return NextResponse.json(
      {
        error:
          "A run needs CH_API_KEY (free from Companies House). Without it only the bundled illustrative companies can be run.",
      },
      { status: 503 },
    );
  }
  const deps: RunDeps = live ? {} : { resolveClient: new FixtureRegisterClient(), build: buildFixtureManifest };

  const run = await createRun(tenantId, input);

  // The work continues after the response is flushed, in this same invocation.
  after(async () => {
    // executeRun never throws: every exit writes a readable record. The catch is belt and
    // braces, because an unhandled rejection inside after() would be logged by the platform
    // with no run record to explain it.
    await executeRun(run, deps).catch(() => {
      /* the record already says where it stopped */
    });
  });

  return NextResponse.json(
    {
      id: run.id,
      status: run.status,
      input: run.input,
      startedAt: run.startedAt,
      stages: run.stages,
      poll: `/api/run/${run.id}`,
      durable: runsAreDurable(),
    },
    { status: 202 },
  );
}
