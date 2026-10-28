// app/api/onboarding/correction/route.ts
// RSI Phase 4: sheet-level correction capture. A client reads a rendered house sheet and corrects
// it in place. Two shapes of correction, which is S10's one-off-versus-persistent classifier in
// its simplest form:
//   - "remap": the client says a field should be a DIFFERENT concept. Picking a concept makes the
//     correction persistent: we learn a per-client synonym (applied first at the next induction,
//     exactly like Phase 1) AND log a feedback event. Nothing is guessed: a remap requires the
//     client to pick a real engine concept, else we refuse.
//   - "note": the client says a value looks wrong but offers no concept. That is a one-off signal,
//     so we log a single feedback event and persist nothing.
// Reuses the Phase 1 storage (no new tables): the same addSynonym + recordFeedback seam.
// Returns 401 without a tenant, 400 on a bad body or an unknown concept.

import { NextResponse } from "next/server";
import { readJsonObject, textField } from "@/lib/http/body";
import { getTenantId } from "@/lib/tenant";
import { getClientSpecStore } from "@/lib/clientspec/store";
import { conceptForKey, normaliseLabel } from "@/lib/clientspec/concepts";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const tenantId = await getTenantId();
  if (!tenantId) return NextResponse.json({ error: "You must be signed in." }, { status: 401 });

  const body = (await readJsonObject(req)) as {
    action?: "remap" | "note";
    label?: string;
    conceptKey?: string;
    note?: string;
  };
  const action = body.action;
  const label = textField(body.label).trim();
  if (!label) return NextResponse.json({ error: "A label is required." }, { status: 400 });

  const store = getClientSpecStore();
  const now = new Date().toISOString();

  if (action === "remap") {
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
      kind: "sheet_correction",
      payload: { mode: "remap", label, conceptKey: concept.key },
      createdAt: now,
    });
    return NextResponse.json({ ok: true, persistent: true });
  }

  if (action === "note") {
    await store.recordFeedback(tenantId, {
      tenantId,
      kind: "sheet_correction",
      payload: { mode: "note", label, note: (body.note ?? "").slice(0, 500) },
      createdAt: now,
    });
    return NextResponse.json({ ok: true, persistent: false });
  }

  return NextResponse.json({ error: "action must be 'remap' or 'note'." }, { status: 400 });
}
