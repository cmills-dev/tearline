// app/api/pipeline/route.ts
// Universe-wide origination screening. POST a mandate plus optional universe filters (SIC
// codes, statuses, incorporation window, location) OR an explicit list of Companies House
// numbers; this builds a candidate pool, screens it member by member through the same Engine C
// path as /api/originate, and returns a ranked, evidence-backed origination list with an honest
// abstain/truncation note. Tenant-scoped (401 without a tenant); a missing CH_API_KEY returns a
// graceful note rather than an error, exactly as the single-target route does.

import { NextResponse } from "next/server";
import { readJsonObject, textField } from "@/lib/http/body";
import { getTenantId } from "@/lib/tenant";
import { getGraphStore } from "@/lib/graph/store";
import { screenUniverse, type ScreenCandidate } from "@/lib/originate/screenUniverse";
import { searchCompanies } from "@/lib/sources/companiesHouseSearch";
import type { MandateLike } from "@/lib/originate/signals";
import { getTenantMandate } from "@/lib/onboarding/mandate";
import { ChBudgetError } from "@/lib/ratelimit/ratelimit";

export const dynamic = "force-dynamic";

interface PipelineBody {
  mandate?: MandateLike;
  sicCodes?: string[];
  statuses?: string[];
  incorporatedFrom?: string;
  incorporatedTo?: string;
  location?: string;
  size?: number; // universe pool size (advanced-search)
  chNumbers?: string[]; // explicit universe, bypassing search
  cap?: number; // hard limit on how many are screened
}

export async function POST(req: Request) {
  const tenantId = await getTenantId();
  if (!tenantId) return NextResponse.json({ error: "You must be signed in." }, { status: 401 });

  const body = (await readJsonObject(req)) as PipelineBody;
  // Fall back to the desk's saved onboarding mandate when the request omits one.
  const mandate = body.mandate ?? (await getTenantMandate(tenantId));

  if (!process.env.CH_API_KEY) {
    return NextResponse.json({
      suggestions: [],
      note: "Universe screening needs CH_API_KEY (free from Companies House). Without it the pipeline returns no candidates.",
    });
  }

  try {
    // The universe is either an explicit CH-number list, or a pool fetched from Advanced Search.
    let candidates: ScreenCandidate[];
    const explicit = (Array.isArray(body.chNumbers) ? body.chNumbers : []).map((n) => textField(n).trim()).filter(Boolean);
    if (explicit.length > 0) {
      candidates = explicit.map((chNumber) => ({ chNumber }));
    } else {
      candidates = await searchCompanies({
        sicCodes: body.sicCodes,
        statuses: body.statuses,
        incorporatedFrom: body.incorporatedFrom,
        incorporatedTo: body.incorporatedTo,
        location: body.location,
        size: body.size,
      });
    }

    if (candidates.length === 0) {
      return NextResponse.json({
        suggestions: [],
        note: "No candidates matched the universe filters. Widen the SIC codes, status or incorporation window.",
      });
    }

    const result = await screenUniverse(tenantId, mandate, candidates, getGraphStore(), { cap: body.cap });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof ChBudgetError) {
      return NextResponse.json(
        { error: "Companies House budget exceeded, retry shortly.", retryAfterSeconds: e.retryAfterSeconds },
        { status: 429 },
      );
    }
    // The detail goes to the log, not the caller (WP-QA03).
    console.error("/api/pipeline failed:", e);
    return NextResponse.json({ error: "The request could not be completed." }, { status: 500 });
  }
}
