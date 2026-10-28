// app/api/onboarding/clientspec/route.ts
// Tenant-scoped ClientSpec induction preview. POST { text, name? } runs the induction engine
// over a pasted example tear sheet and returns the induced spec plus its honest abstentions
// for the analyst to confirm. This is a PREVIEW only: nothing is persisted here. The analyst
// reviews / edits the result client-side and commits it via /api/onboarding/activate.
// Returns 401 when there is no tenant, 400 when no example text was pasted.

import { NextResponse } from "next/server";
import { readJsonObject, textField } from "@/lib/http/body";
import { getTenantId } from "@/lib/tenant";
import { induceClientSpec } from "@/lib/clientspec/induce";
import { getClientSpecStore } from "@/lib/clientspec/store";
import { getSharedLearningStore } from "@/lib/clientspec/sharedStore";
import type { ClientSynonym } from "@/lib/clientspec/types";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const tenantId = await getTenantId();
  if (!tenantId) return NextResponse.json({ error: "You must be signed in." }, { status: 401 });

  const body = (await readJsonObject(req)) as { text?: string; name?: string };
  const text = textField(body.text);
  const name = textField(body.name) || undefined;
  if (!text.trim()) return NextResponse.json({ error: "Paste your example tear sheet text." }, { status: 400 });
  // Bound the input so a pathological paste cannot burn unbounded CPU in induction.
  const MAX_TEXT = 256 * 1024;
  if (text.length > MAX_TEXT) return NextResponse.json({ error: "That sheet is too large; paste up to 256 KB of text." }, { status: 413 });

  // Resolution order at induction: this tenant's OWN learned synonyms first (RSI Phase 1), then
  // the promoted shared dictionary (RSI Phase 3), then the static base dictionary, then abstain.
  // Client synonyms must win over shared ones, and induce builds its map so later array entries
  // override earlier, so shared entries are listed BEFORE the tenant's own. The tenant is the
  // clientId, so the spec belongs to this desk, never a client-supplied id.
  const own = await getClientSpecStore().listSynonyms(tenantId);
  const shared = await getSharedLearningStore().activeEntries();
  const sharedAsSynonyms: ClientSynonym[] = shared.map((e) => ({
    labelNorm: e.labelNorm,
    conceptKey: e.conceptKey,
    sourceLabel: e.labelNorm,
    confirmedAt: "",
  }));
  const synonyms = [...sharedAsSynonyms, ...own];
  return NextResponse.json({ induced: induceClientSpec({ text, name }, tenantId, { synonyms }) });
}
