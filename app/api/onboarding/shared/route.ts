// app/api/onboarding/shared/route.ts
// The shared-learning review + promotion surface (RSI Phases 2 to 3). GET returns the
// de-identified candidate queue (normalised label, concept, distinct-tenant count, status) with
// the automated gate verdict per candidate. POST promotes or rejects a candidate. Promotion
// passes FOUR gates before a mapping can enter the shared dictionary:
//   1. k-anonymity + token filter + no base conflict  (lib/clientspec/promote.ts, pure)
//   2. an induction EVAL gate: replay the 30-sheet gold set with the proposed entry and block if
//      it causes ANY sheet to map a concept its ground truth does not expect (a mis-map)
//   3. human sign-off: this endpoint is the analyst action
//   4. an admin secret when SHARED_ADMIN_SECRET is set (open in the keyless demo, like the cron)
// Nothing client-identifying is read or returned; the shared plane stores only labels + counts.

import { NextResponse } from "next/server";
import { readJsonObject, textField } from "@/lib/http/body";
import { timingSafeEqual } from "crypto";
import { getTenantId } from "@/lib/tenant";
import { getSharedLearningStore } from "@/lib/clientspec/sharedStore";
import { decideCandidates, visibleCandidates } from "@/lib/clientspec/promote";
import { induceClientSpec } from "@/lib/clientspec/induce";
import type { ClientSynonym, SharedDictionaryEntry } from "@/lib/clientspec/types";
import { WACKY_SHEETS } from "@/test/fixtures/wackySheets";

export const dynamic = "force-dynamic";

// Constant-time comparison so the admin secret cannot be probed by timing.
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function adminOk(req: Request): boolean {
  const secret = process.env.SHARED_ADMIN_SECRET;
  if (!secret) return true; // demo: promotion is open when no admin secret is configured (in
  // production the prod-guard requires SHARED_ADMIN_SECRET, so promotion is never open there)
  return safeEqual(req.headers.get("x-admin-secret") ?? "", secret);
}

export async function GET(req: Request) {
  const tenantId = await getTenantId();
  if (!tenantId) return NextResponse.json({ error: "You must be signed in." }, { status: 401 });

  const store = getSharedLearningStore();
  // Only a caller holding the admin secret sees candidates below k. In the keyless demo adminOk
  // is open, as it is for promotion; production requires SHARED_ADMIN_SECRET.
  const candidates = await visibleCandidates(store, !!process.env.SHARED_ADMIN_SECRET && adminOk(req));
  const decisions = decideCandidates(candidates);
  const byKey = new Map(decisions.map((d) => [`${d.entry.labelNorm} ${d.entry.conceptKey}`, d]));

  const merged = candidates.map((c) => {
    const d = byKey.get(`${c.labelNorm} ${c.conceptKey}`);
    return { ...c, promote: d?.promote ?? false, reasons: d?.reasons ?? ["no decision"] };
  });
  // Strongest first: promotable, then by how many desks confirmed.
  merged.sort((a, b) => Number(b.promote) - Number(a.promote) || b.distinctTenants - a.distinctTenants);

  return NextResponse.json({
    activeVersion: await store.activeVersion(),
    activeEntries: await store.activeEntries(),
    candidates: merged,
    adminRequired: !!process.env.SHARED_ADMIN_SECRET,
  });
}

// The induction eval gate: promoting `entry` must not cause any gold sheet to bind a concept its
// ground truth does not expect. Returns the names of any sheets that would regress (empty = safe).
function evalRegressions(existing: SharedDictionaryEntry[], entry: SharedDictionaryEntry): string[] {
  const asSyn = (e: SharedDictionaryEntry): ClientSynonym => ({
    labelNorm: e.labelNorm,
    conceptKey: e.conceptKey,
    sourceLabel: e.labelNorm,
    confirmedAt: "",
  });
  const synonyms = [...existing, entry].map(asSyn);
  const regressed: string[] = [];
  for (const sheet of WACKY_SHEETS) {
    const { spec } = induceClientSpec({ text: sheet.text, name: sheet.name }, "eval", { synonyms });
    const keys = spec.fields.map((f) => f.key);
    // Any mapped key outside the sheet's expected set is a mis-map the shared entry introduced.
    if (keys.some((k) => !sheet.expectMapped.includes(k))) regressed.push(sheet.name);
  }
  return regressed;
}

export async function POST(req: Request) {
  const tenantId = await getTenantId();
  if (!tenantId) return NextResponse.json({ error: "You must be signed in." }, { status: 401 });
  if (!adminOk(req)) return NextResponse.json({ error: "Promotion requires the admin secret." }, { status: 403 });

  const body = (await readJsonObject(req)) as {
    action?: "promote" | "reject";
    labelNorm?: string;
    conceptKey?: string;
  };
  const labelNorm = textField(body.labelNorm).trim();
  const conceptKey = textField(body.conceptKey).trim();
  if (!labelNorm || !conceptKey) return NextResponse.json({ error: "labelNorm and conceptKey are required." }, { status: 400 });

  const store = getSharedLearningStore();

  if (body.action === "reject") {
    await store.setCandidateStatus(labelNorm, conceptKey, "rejected");
    return NextResponse.json({ ok: true });
  }

  if (body.action === "promote") {
    // Gate 1: the pure policy (k-anonymity, token filter, base conflict, not rejected).
    const candidates = await store.listCandidates();
    const candidate = candidates.find((c) => c.labelNorm === labelNorm && c.conceptKey === conceptKey);
    if (!candidate) return NextResponse.json({ error: "No such candidate." }, { status: 404 });
    const [decision] = decideCandidates([candidate]);
    if (!decision?.promote) {
      return NextResponse.json({ error: `Blocked by policy: ${decision?.reasons.join("; ") ?? "unknown"}` }, { status: 400 });
    }

    // Gate 2: the induction eval on the gold set.
    const entry: SharedDictionaryEntry = { labelNorm, conceptKey };
    const active = await store.activeEntries();
    const regressed = evalRegressions(active, entry);
    if (regressed.length > 0) {
      return NextResponse.json({ error: `Blocked by eval: would mis-map ${regressed.join(", ")}.` }, { status: 400 });
    }

    // All gates clear: approve and append to a new dictionary version (dedup by label+concept).
    await store.setCandidateStatus(labelNorm, conceptKey, "approved");
    const next = [...active.filter((e) => !(e.labelNorm === labelNorm && e.conceptKey === conceptKey)), entry];
    const version = await store.promote(next, "analyst");
    return NextResponse.json({ ok: true, version });
  }

  return NextResponse.json({ error: "action must be 'promote' or 'reject'." }, { status: 400 });
}
