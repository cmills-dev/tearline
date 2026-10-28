// app/api/onboarding/state/route.ts
// Tenant-scoped onboarding progress. GET returns the tenant's current OnboardingState (never
// null; a fresh tenant gets an empty state). POST { step?, firmName? } advances the wizard:
// a valid step is added to completedSteps (deduped) and a firmName captured in the desk step is
// stored, then the updated state is returned.
// Returns 401 when there is no tenant.

import { NextResponse } from "next/server";
import { readJsonObject } from "@/lib/http/body";
import { getTenantId } from "@/lib/tenant";
import { getClientSpecStore } from "@/lib/clientspec/store";
import { ONBOARDING_STEPS, type OnboardingStepId, type OnboardingMandate } from "@/lib/clientspec/types";

export const dynamic = "force-dynamic";

const MAX_SECTORS = 40;

// Coerce an untrusted body into a bounded, well-typed mandate: sectors capped and trimmed,
// numeric bounds kept only when finite and non-negative. Returns undefined when nothing usable
// is present, so an empty desk step never overwrites a previously-saved mandate with junk.
function coerceMandate(raw: unknown): OnboardingMandate | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const num = (x: unknown): number | undefined =>
    typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : undefined;
  const sectors = Array.isArray(r.sectors)
    ? r.sectors.filter((s): s is string => typeof s === "string" && s.trim().length > 0).map((s) => s.trim()).slice(0, MAX_SECTORS)
    : undefined;
  const mandate: OnboardingMandate = {};
  if (sectors && sectors.length) mandate.sectors = sectors;
  const minT = num(r.minTurnover); if (minT !== undefined) mandate.minTurnover = minT;
  const maxT = num(r.maxTurnover); if (maxT !== undefined) mandate.maxTurnover = maxT;
  const maxL = num(r.maxLeverage); if (maxL !== undefined) mandate.maxLeverage = maxL;
  return Object.keys(mandate).length ? mandate : undefined;
}

export async function GET() {
  const tenantId = await getTenantId();
  if (!tenantId) return NextResponse.json({ error: "You must be signed in." }, { status: 401 });

  return NextResponse.json(await getClientSpecStore().getState(tenantId));
}

export async function POST(req: Request) {
  const tenantId = await getTenantId();
  if (!tenantId) return NextResponse.json({ error: "You must be signed in." }, { status: 401 });

  const body = (await readJsonObject(req)) as { step?: OnboardingStepId; firmName?: string; mandate?: unknown };
  const store = getClientSpecStore();
  const state = await store.getState(tenantId);

  if (body.step && ONBOARDING_STEPS.includes(body.step) && !state.completedSteps.includes(body.step)) {
    state.completedSteps.push(body.step);
  }
  // Text only, capped like /api/onboarding/network: an object here was stored and later broke the
  // onboarding page's own firmName.trim() (WP-QA03).
  if (typeof body.firmName === "string") state.firmName = body.firmName.trim().slice(0, 200);
  const mandate = coerceMandate(body.mandate);
  if (mandate) state.mandate = mandate;

  await store.setState(tenantId, state);
  return NextResponse.json(state);
}
