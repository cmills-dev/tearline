// app/api/originate/route.ts
// Engine C on real data: POST { chNumber, mandate? } -> an OriginationSuggestion for that
// target, joining its cited catalyst with a warm path through the tenant's own network.
// Tenant-scoped; needs CH_API_KEY for the live financials/network (returns an honest note
// otherwise). The graph carries the tenant's onboarded relationships.

import { NextResponse } from "next/server";
import { readJsonObject, textField } from "@/lib/http/body";
import { getTenantId } from "@/lib/tenant";
import { getGraphStore } from "@/lib/graph/store";
import { originateForTarget } from "@/lib/originate/live";
import { ChBudgetError } from "@/lib/ratelimit/ratelimit";
import { getTenantMandate } from "@/lib/onboarding/mandate";
import type { MandateLike } from "@/lib/originate/signals";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const tenantId = await getTenantId();
  if (!tenantId) return NextResponse.json({ error: "You must be signed in." }, { status: 401 });
  const body = (await readJsonObject(req)) as { chNumber?: string; mandate?: MandateLike };
  const chNumber = textField(body.chNumber).trim();
  if (!chNumber) return NextResponse.json({ error: "chNumber required" }, { status: 400 });
  if (!process.env.CH_API_KEY) {
    return NextResponse.json({ error: "Live origination needs CH_API_KEY (free from Companies House)." }, { status: 400 });
  }
  // Fall back to the desk's saved mandate (from onboarding) when the request omits one, so
  // fit-scoring runs against the tenant's stated sectors / size band / leverage ceiling.
  const mandate = body.mandate ?? (await getTenantMandate(tenantId));
  try {
    const suggestion = await originateForTarget(tenantId, chNumber, mandate, getGraphStore());
    if (!suggestion) return NextResponse.json({ suggestion: null, note: "No cited catalyst established for this target - abstained." });
    return NextResponse.json({ suggestion });
  } catch (e) {
    // Budget exhaustion is a retryable rate-limit condition, not a target-level failure or an
    // abstention: report it as 429 with the retry hint so the caller distinguishes the two.
    if (e instanceof ChBudgetError) {
      return NextResponse.json(
        { error: e.message, retryAfterSeconds: e.retryAfterSeconds },
        { status: 429, headers: { "Retry-After": String(e.retryAfterSeconds) } },
      );
    }
    // The detail goes to the log, not the caller: a driver, register or TypeError message is
    // not something a client should read (WP-QA03).
    console.error(`${new URL(req.url).pathname} failed:`, e);
    return NextResponse.json({ error: "The request could not be completed." }, { status: 500 });
  }
}
