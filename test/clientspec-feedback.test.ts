// test/clientspec-feedback.test.ts
// The RSI Phase 1 persistence seam: learned synonyms upsert by labelNorm (latest write wins, one
// entry per label), the feedback trail is append-only and read back newest-first, and both are
// strictly tenant isolated so one desk never sees another's synonyms or feedback. In-memory only
// (no database); async because the store interface is async, so the runner awaits the registrar
// before the harness.

import { suite, test, assert, assertEqual } from "./harness";
import { getClientSpecStore, resetClientSpecStoreForTests } from "../lib/clientspec/store";
import type { ClientSynonym, FeedbackEvent } from "../lib/clientspec/types";

// A learned synonym; labelNorm is already normalised on the way in (callers use normaliseLabel).
function synFor(labelNorm: string, conceptKey: string, sourceLabel: string, confirmedAt: string): ClientSynonym {
  return { labelNorm, conceptKey, sourceLabel, confirmedAt };
}

// A feedback event; tenantId is a placeholder the store pins defensively on the way in.
function feedbackFor(kind: FeedbackEvent["kind"], payload: Record<string, unknown>, createdAt: string): FeedbackEvent {
  return { tenantId: "placeholder", kind, payload, createdAt };
}

export async function registerClientSpecFeedbackTests(): Promise<void> {
  suite("clientspec / feedback");

  // --- (a) addSynonym then listSynonyms returns it -------------------------
  resetClientSpecStoreForTests();
  const store = getClientSpecStore();
  await store.addSynonym("a", synFor("adj ebitda", "concept:ebitda", "Adj. EBITDA", "2026-08-19T09:00:00.000Z"));
  const synsA = await store.listSynonyms("a");
  test("addSynonym then listSynonyms returns the synonym", () => {
    assertEqual(synsA.length, 1, "the one added synonym is listed");
    assertEqual(synsA[0].labelNorm, "adj ebitda", "the synonym keeps its normalised label");
    assertEqual(synsA[0].conceptKey, "concept:ebitda", "the synonym keeps its concept key");
    assertEqual(synsA[0].sourceLabel, "Adj. EBITDA", "the synonym keeps its source label");
  });

  // --- (b) addSynonym upserts by labelNorm ---------------------------------
  resetClientSpecStoreForTests();
  const store2 = getClientSpecStore();
  await store2.addSynonym("a", synFor("net debt", "concept:wrong", "Net debt", "2026-08-19T09:00:00.000Z"));
  await store2.addSynonym("a", synFor("net debt", "concept:netdebt", "Net Debt (adj)", "2026-08-20T10:00:00.000Z"));
  const upserted = await store2.listSynonyms("a");
  test("addSynonym upserts by labelNorm so the latest write wins", () => {
    assertEqual(upserted.length, 1, "the same labelNorm stays a single entry");
    assertEqual(upserted[0].conceptKey, "concept:netdebt", "the second write overwrites the concept");
    assertEqual(upserted[0].sourceLabel, "Net Debt (adj)", "the second write overwrites the source label");
    assertEqual(upserted[0].confirmedAt, "2026-08-20T10:00:00.000Z", "the second write overwrites the time");
  });

  // --- (c) recordFeedback then listFeedback returns newest first -----------
  resetClientSpecStoreForTests();
  const store3 = getClientSpecStore();
  await store3.recordFeedback("a", feedbackFor("label_edit", { field: "ebitda" }, "2026-08-19T09:00:00.000Z"));
  await store3.recordFeedback("a", feedbackFor("abstention_resolved", { label: "OCF" }, "2026-08-20T09:00:00.000Z"));
  const feed = await store3.listFeedback("a");
  test("recordFeedback then listFeedback returns events newest first", () => {
    assertEqual(feed.length, 2, "both recorded events are listed");
    assertEqual(feed[0].kind, "abstention_resolved", "the newest event is first");
    assertEqual(feed[1].kind, "label_edit", "the oldest event is last");
    assertEqual(feed[0].tenantId, "a", "recordFeedback pins the tenant id defensively");
  });

  // --- (c2) listFeedback honours the limit, still newest first -------------
  const capped = await store3.listFeedback("a", 1);
  test("listFeedback caps at the limit, keeping newest first", () => {
    assertEqual(capped.length, 1, "the limit caps the returned events");
    assertEqual(capped[0].kind, "abstention_resolved", "the capped result is still the newest event");
  });

  // --- (d) tenant isolation ------------------------------------------------
  resetClientSpecStoreForTests();
  const store4 = getClientSpecStore();
  await store4.addSynonym("a", synFor("adj ebitda", "concept:ebitda", "Adj. EBITDA", "2026-08-19T09:00:00.000Z"));
  await store4.recordFeedback("a", feedbackFor("label_edit", { field: "ebitda" }, "2026-08-19T09:00:00.000Z"));
  const bSyns = await store4.listSynonyms("b");
  const bFeed = await store4.listFeedback("b");
  test("tenant b cannot see tenant a's synonyms or feedback", () => {
    assertEqual(bSyns.length, 0, "tenant b sees none of tenant a's synonyms");
    assertEqual(bFeed.length, 0, "tenant b sees none of tenant a's feedback");
    assert(bSyns !== null && bFeed !== null, "tenant b gets its own empty lists, never null");
  });
}
