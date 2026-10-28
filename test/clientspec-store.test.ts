// test/clientspec-store.test.ts
// The ClientSpec persistence seam: versioning assigns 1 then 2 on re-save, listSpecs returns
// newest-version-first, the active pointer round-trips through onboarding state, a fresh tenant
// gets an empty state that setState then persists, and the whole thing is strictly tenant
// isolated so one desk never sees another's specs or state. In-memory only (no database); async
// because the store interface is async, so the runner awaits the registrar before the harness.

import { suite, test, assert, assertEqual } from "./harness";
import { getClientSpecStore, resetClientSpecStoreForTests } from "../lib/clientspec/store";
import type { ClientSpec } from "../lib/clientspec/types";

// A minimal but complete ClientSpec for a tenant; version is a placeholder the store overwrites.
function specFor(clientId: string, name: string): ClientSpec {
  return {
    contractVersion: "0",
    clientId,
    version: 0,
    name,
    fields: [{ key: "ebitda", label: "Adjusted EBITDA", ontologyConcept: "concept:ebitda", required: true }],
    styleTokens: { voice: "analyst-understated", numberStyle: "tabular", dateFormat: "D MMM YYYY", currencyDefault: "GBP" },
    skeleton: ["Header", "Financials"],
    inducedFrom: ["Acme house sheet Q3"],
    createdAt: "2026-08-19T09:00:00.000Z",
  };
}

export async function registerClientSpecStoreTests(): Promise<void> {
  suite("clientspec / store");

  // --- (a) saveSpec assigns 1 then 2 on re-save ----------------------------
  resetClientSpecStoreForTests();
  const store = getClientSpecStore();
  const v1 = await store.saveSpec("a", specFor("a", "First"));
  const v2 = await store.saveSpec("a", specFor("a", "Second"));

  test("saveSpec assigns version 1 then 2 on re-save", () => {
    assertEqual(v1, 1, "the first save is version 1");
    assertEqual(v2, 2, "the second save is version 2");
  });

  // --- (b) listSpecs newest first ------------------------------------------
  const listed = await store.listSpecs("a");
  test("listSpecs returns specs newest version first", () => {
    assertEqual(listed.length, 2, "both saved specs are listed");
    assertEqual(listed[0].version, 2, "the newest version is first");
    assertEqual(listed[1].version, 1, "the oldest version is last");
    assertEqual(listed[0].name, "Second", "the newest spec keeps its name");
  });

  // --- (c) setActiveSpec then getActiveSpec round-trips the right version ----
  const noneActive = await store.getActiveSpec("a");
  await store.setActiveSpec("a", 1);
  const active = await store.getActiveSpec("a");
  test("setActiveSpec then getActiveSpec round-trips the right version", () => {
    assertEqual(noneActive, null, "no spec is active until the pointer is set");
    assert(active !== null, "a spec is active once the pointer is set");
    assertEqual(active!.version, 1, "the active spec is the pointed-at version");
    assertEqual(active!.name, "First", "the active spec is the right record");
  });

  // --- (d) getState defaults to empty, then setState persists ---------------
  resetClientSpecStoreForTests();
  const store2 = getClientSpecStore();
  const fresh = await store2.getState("a");
  await store2.setState("a", { ...fresh, firmName: "Acme Capital", completedSteps: ["desk"] });
  const saved = await store2.getState("a");
  test("getState defaults to an empty state then setState persists", () => {
    assertEqual(fresh.tenantId, "a", "the empty state is scoped to the tenant");
    assertEqual(fresh.completedSteps.length, 0, "a fresh tenant has no completed steps");
    assertEqual(fresh.activeSpecVersion, null, "a fresh tenant has no active spec");
    assertEqual(fresh.complete, false, "a fresh tenant is not complete");
    assertEqual(saved.firmName, "Acme Capital", "setState persists the firm name");
    assertEqual(saved.completedSteps[0], "desk", "setState persists the completed steps");
  });

  // --- (e) tenant isolation -------------------------------------------------
  resetClientSpecStoreForTests();
  const store3 = getClientSpecStore();
  await store3.saveSpec("a", specFor("a", "A house sheet"));
  await store3.setActiveSpec("a", 1);
  await store3.setState("a", { ...(await store3.getState("a")), firmName: "Tenant A" });

  const bSpecs = await store3.listSpecs("b");
  const bActive = await store3.getActiveSpec("b");
  const bState = await store3.getState("b");
  test("tenant b cannot see tenant a's specs or state", () => {
    assertEqual(bSpecs.length, 0, "tenant b sees none of tenant a's specs");
    assertEqual(bActive, null, "tenant b has no active spec of tenant a's");
    assertEqual(bState.firmName, undefined, "tenant b sees none of tenant a's state");
    assertEqual(bState.activeSpecVersion, null, "tenant b has its own empty pointer");
  });
}
