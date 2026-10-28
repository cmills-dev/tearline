// app/api/onboarding/network/route.ts
// Tenant-scoped network seeding for the setup wizard's "network" step. POST { firmName?,
// relationships[] } seeds the desk's private relationship graph (the firm node plus one node
// and edge per stated relationship), reusing the same applyExtraction path the conversational
// onboarding uses, so a counterparty the desk knows resolves to the same node a target's
// filings name (which is what lets a warm path connect the two). Also advances the onboarding
// state: marks the "network" step complete and records the firm name. Every edge is stored with
// a "stated by the client" provenance and stays tenant-private; nothing is invented or resold.
// Returns 401 when there is no tenant.

import { NextResponse } from "next/server";
import { readJsonObject } from "@/lib/http/body";
import { getTenantId } from "@/lib/tenant";
import { getGraphStore } from "@/lib/graph/store";
import { getClientSpecStore } from "@/lib/clientspec/store";
import { applyExtraction } from "@/lib/onboarding/tools";
import { emptyProfile } from "@/lib/onboarding/profile";
import { MAX_RELATIONSHIPS, readNetworkBody } from "@/lib/onboarding/networkBody";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const tenantId = await getTenantId();
  if (!tenantId) return NextResponse.json({ error: "You must be signed in." }, { status: 401 });

  // The caps, and the refusal of a body with no relationships list, live in readNetworkBody.
  const parsed = readNetworkBody(await readJsonObject(req));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { firmName, relationships, droppedRelationships } = parsed;

  const store = getGraphStore();
  const profile = emptyProfile();
  const ctx = { tenantId, store };

  if (firmName) {
    await applyExtraction(profile, "firmName", { firmName }, ctx);
  }
  const { seeded } = await applyExtraction(
    profile,
    "relationships",
    { relationships },
    ctx,
  );

  // Advance onboarding progress: the network step is done, and the firm name is recorded.
  const specStore = getClientSpecStore();
  const state = await specStore.getState(tenantId);
  if (!state.completedSteps.includes("network")) state.completedSteps.push("network");
  if (firmName) state.firmName = firmName;
  await specStore.setState(tenantId, state);

  return NextResponse.json({
    seeded,
    state,
    ...(droppedRelationships > 0
      ? { note: `Only the first ${MAX_RELATIONSHIPS} relationships were seeded; ${droppedRelationships} beyond the cap were not.` }
      : {}),
  });
}
