// test/persistence.test.ts
// Two persistence guarantees, tenant-scoped:
//   1. Origination shortlists (a saved OriginationSuggestion) round-trip under the same
//      tenant and are invisible to another tenant.
//   2. The tear-sheet save path (FactManifest through the store) still round-trips, so the
//      second record kind did not disturb the first.
// Async because the workspace/store interfaces are async; the runner awaits the registrar.

import { suite, test, assert, assertEqual } from "./harness";
import {
  saveSuggestion,
  listSuggestions,
  resetSuggestionsForTests,
  saveManifest,
  getTearSheet,
  listWorkspace,
} from "../lib/workspace";
import { resetStoreForTests } from "../lib/store/tearSheetStore";
import { manifestForKey } from "../lib/engine/pipeline";
import type { OriginationSuggestion } from "../lib/originate/suggestion";

function suggestionFor(chNumber: string, name: string): OriginationSuggestion {
  return {
    target: { nodeId: `co:${chNumber}`, name, chNumber },
    tier: "cold",
    whyNow: [
      {
        id: "high_leverage.FY2024",
        type: "high_leverage",
        category: "condition",
        label: "Leverage",
        detail: "Net leverage 5.20x",
        direction: "negative",
        source: {
          sourceId: "s",
          tag: "Acc",
          documentName: "Annual report",
          locator: "p.1",
          snippet: "x",
          retrievedAt: "2026-08-18",
          contentHash: "h",
        },
        rung: "R2",
      },
    ],
    fit: [],
    warmPath: null,
    score: { total: 0.42, catalyst: 0.6, fit: 1, pathGate: 0.7 },
    abstentions: [],
  };
}

export async function registerPersistenceTests(): Promise<void> {
  resetSuggestionsForTests();
  resetStoreForTests();

  // --- Shortlists ---
  await saveSuggestion("tenantA", suggestionFor("00000001", "TARGET ONE LTD"));
  await saveSuggestion("tenantA", suggestionFor("00000002", "TARGET TWO LTD"));
  const aList = await listSuggestions("tenantA");
  const bList = await listSuggestions("tenantB");

  // Re-saving the same target replaces rather than duplicates.
  await saveSuggestion("tenantA", suggestionFor("00000001", "TARGET ONE RENAMED LTD"));
  const aAfterReplace = await listSuggestions("tenantA");

  // --- Tear-sheet save path still round-trips ---
  const manifest = manifestForKey("meridian")!;
  await saveManifest("tenantA", "sec-cik-test", manifest);
  const reopened = await getTearSheet("tenantA", "sec-cik-test");
  const aWorkspace = await listWorkspace("tenantA");
  const bWorkspace = await listWorkspace("tenantB");

  suite("persistence / shortlists + tear sheets");

  test("a saved suggestion lists back under the same tenant", () => {
    assertEqual(aList.length, 2, "tenantA has both saved suggestions");
    assert(aList.some((s) => s.target.chNumber === "00000001"), "target one is listed");
    assert(aList.every((s) => typeof s.savedAt === "string" && s.savedAt.length > 0), "each carries savedAt");
  });

  test("another tenant cannot see saved suggestions (isolation)", () => {
    assertEqual(bList.length, 0, "tenantB sees none of tenantA's shortlists");
  });

  test("re-saving the same target replaces, not duplicates", () => {
    assertEqual(aAfterReplace.length, 2, "still two suggestions after re-save");
    const one = aAfterReplace.find((s) => s.target.chNumber === "00000001");
    assertEqual(one?.target.name, "TARGET ONE RENAMED LTD", "the record was replaced");
  });

  test("a saved manifest reopens as a tear sheet for the tenant", () => {
    assert(reopened !== null, "sec-cik-test reopens");
    assert(aWorkspace.some((r) => r.key === "sec-cik-test"), "it appears in the workspace list");
  });

  test("another tenant cannot see the saved tear sheet (isolation)", () => {
    assertEqual(bWorkspace.length, 0, "tenantB sees none of tenantA's tear sheets");
  });
}
