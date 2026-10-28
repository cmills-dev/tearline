// app/api/onboarding/activate/route.ts
// Tenant-scoped ClientSpec activation. POST { spec } takes the analyst-confirmed spec (possibly
// edited client-side after the induction preview), saves it as the next version for this tenant,
// points the active pointer at it, and advances onboarding: the housesheet and review steps are
// marked complete and the wizard is signed off. Returns { version, state }.
// Returns 401 when there is no tenant, 400 when the spec is not a well-formed ClientSpec.

import { NextResponse } from "next/server";
import { readJsonObject } from "@/lib/http/body";
import { getTenantId } from "@/lib/tenant";
import { getClientSpecStore } from "@/lib/clientspec/store";
import type { ClientSpec } from "@/lib/clientspec/types";

export const dynamic = "force-dynamic";

// A tear-sheet spec has one field per rendered line; a real one is tens of fields. Cap it so a
// hand-crafted request cannot persist an enormous spec (which every later render would walk).
const MAX_SPEC_FIELDS = 300;

export async function POST(req: Request) {
  const tenantId = await getTenantId();
  if (!tenantId) return NextResponse.json({ error: "You must be signed in." }, { status: 401 });

  const body = (await readJsonObject(req)) as { spec?: unknown };
  const spec = body.spec;
  if (!spec || typeof spec !== "object" || !Array.isArray((spec as ClientSpec).fields)) {
    return NextResponse.json({ error: "A ClientSpec with a fields array is required." }, { status: 400 });
  }
  if ((spec as ClientSpec).fields.length > MAX_SPEC_FIELDS) {
    return NextResponse.json({ error: `A ClientSpec is capped at ${MAX_SPEC_FIELDS} fields.` }, { status: 400 });
  }

  // Force the spec's clientId to the authenticated tenant, never trust the body's. The store keys
  // strictly by the tenantId argument, so this is defence in depth, but it also stops a
  // hand-crafted clientId echoing back through the rendered sheet.
  (spec as ClientSpec).clientId = tenantId;

  const store = getClientSpecStore();
  const version = await store.saveSpec(tenantId, spec as ClientSpec);
  await store.setActiveSpec(tenantId, version);

  const state = await store.getState(tenantId);
  state.activeSpecVersion = version;
  for (const step of ["housesheet", "review"] as const) {
    if (!state.completedSteps.includes(step)) state.completedSteps.push(step);
  }
  state.complete = true;
  await store.setState(tenantId, state);

  return NextResponse.json({ version, state });
}
