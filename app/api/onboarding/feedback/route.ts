// app/api/onboarding/feedback/route.ts
// RSI Phase 1: the per-client feedback endpoint. When a client resolves one of the induction's
// honest abstentions ("this unmapped line IS EBITDA"), we record the correction as a learned
// synonym for THAT tenant, so the same label maps on their next sheet, and we log a feedback
// event for the audit trail. When they dismiss a line ("leave it out"), we just log it. All
// tenant-scoped and in-silo: a client's vocabulary never leaves their tenant (promotion to a
// shared dictionary is a later, gated phase). Nothing is guessed: a resolution binds only to a
// real engine concept the client explicitly chose.
// Returns 401 without a tenant, 400 on a bad body or an unknown concept.

import { NextResponse } from "next/server";
import { readJsonObject, textField } from "@/lib/http/body";
import { getSession, getTenantId } from "@/lib/tenant";
import { getClientSpecStore } from "@/lib/clientspec/store";
import { getSharedLearningStore } from "@/lib/clientspec/sharedStore";
import { conceptForKey, normaliseLabel } from "@/lib/clientspec/concepts";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const tenantId = await getTenantId();
  if (!tenantId) return NextResponse.json({ error: "You must be signed in." }, { status: 401 });

  const body = (await readJsonObject(req)) as {
    action?: "resolve" | "dismiss";
    label?: string;
    conceptKey?: string;
  };
  const action = body.action;
  const label = textField(body.label).trim();
  if (!label) return NextResponse.json({ error: "A label is required." }, { status: 400 });

  const store = getClientSpecStore();
  const now = new Date().toISOString();

  if (action === "resolve") {
    const concept = body.conceptKey ? conceptForKey(body.conceptKey) : undefined;
    if (!concept) return NextResponse.json({ error: "Unknown concept." }, { status: 400 });
    await store.addSynonym(tenantId, {
      labelNorm: normaliseLabel(label),
      conceptKey: concept.key,
      sourceLabel: label,
      confirmedAt: now,
    });
    await store.recordFeedback(tenantId, {
      tenantId,
      kind: "abstention_resolved",
      payload: { label, conceptKey: concept.key },
      createdAt: now,
    });
    // RSI Phase 2: contribute this confirmed mapping to the DE-IDENTIFIED shared plane. Only the
    // normalised label, the concept, and a one-way hash of the tenant are recorded there, so a
    // cross-tenant count can build without any client-identifying content crossing the wall.
    // Only a verified session counts toward k; an anonymous tenant is not an identity (WP-QA05).
    const session = await getSession();
    if (session) await getSharedLearningStore().contribute(normaliseLabel(label), concept.key, session.tenantId);
    // Hand back a ready-to-use spec field so the client can drop it straight into the sheet.
    return NextResponse.json({
      ok: true,
      field: {
        key: concept.key,
        label,
        ontologyConcept: concept.key,
        required: false,
        format: concept.format,
      },
    });
  }

  if (action === "dismiss") {
    await store.recordFeedback(tenantId, {
      tenantId,
      kind: "abstention_dismissed",
      payload: { label },
      createdAt: now,
    });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "action must be 'resolve' or 'dismiss'." }, { status: 400 });
}
