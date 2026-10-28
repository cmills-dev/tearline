// test/contracts.test.ts
// The frozen-contract validators (sync, registered on import) and the persistence seam
// round-trip (async, registered via the registrar the runner awaits).

import { suite, test, assert, assertEqual } from "./harness";
import { buildManifest } from "../lib/engine/buildManifest";
import { meridian } from "../lib/sources/fixtures/meridian";
import { validateFactManifest, validateFact, validateClientSpec } from "../lib/contracts/validate";
import { InMemoryTearSheetStore } from "../lib/store/tearSheetStore";
import type { ClientSpec } from "../lib/contracts/clientSpec";
import type { FactManifest } from "../lib/engine/types";

suite("contracts / validators");

test("a real assembled manifest passes validation", () => {
  const r = validateFactManifest(buildManifest(meridian));
  assert(r.ok, "meridian manifest is valid: " + r.errors.join("; "));
});

test("an R4 fact carrying a value is rejected", () => {
  const bad = {
    id: "x.FY", metric: "x", label: "X", period: "FY", kind: "currency",
    unit: "GBP", rung: "R4", value: 5, verification: { status: "NOT_APPLICABLE", checks: [] },
  };
  assert(validateFact(bad).some((e) => e.includes("null value")), "R4 with a value must be flagged");
});

test("an R1 reported fact without provenance is rejected", () => {
  const bad = {
    id: "x.FY", metric: "x", label: "X", period: "FY", kind: "currency",
    unit: "GBP", rung: "R1", value: 5, provenance: null,
    verification: { status: "SINGLE_SOURCE", checks: [] },
  };
  assert(validateFact(bad).some((e) => e.includes("provenance")), "R1 with a value must carry provenance");
});

test("a valid ClientSpec passes and a malformed one fails", () => {
  const spec: ClientSpec = {
    contractVersion: "0.1.0",
    clientId: "c1",
    version: 1,
    name: "Desk A",
    fields: [{ key: "ebitda", label: "Adjusted EBITDA", ontologyConcept: "credit:ebitda", required: true }],
    styleTokens: { voice: "analyst-understated", numberStyle: "tabular", dateFormat: "D MMM YYYY", currencyDefault: "GBP" },
    skeleton: ["Header", "Financials"],
    inducedFrom: ["example-1"],
    createdAt: "2026-07-30",
  };
  assert(validateClientSpec(spec).ok, "valid spec passes");
  assert(!validateClientSpec({ clientId: 5 }).ok, "malformed spec fails");
});

// Async store round-trip: the runner awaits this before running the harness.
export async function registerContractStoreTests(): Promise<void> {
  const store = new InMemoryTearSheetStore();
  const manifest = buildManifest(meridian);
  await store.save("tenant-1", "meridian", manifest);
  const loaded = await store.load("tenant-1", "meridian");
  const crossTenant = await store.load("tenant-2", "meridian");
  const refs = await store.list("tenant-1");

  let rejected = false;
  try {
    await store.save("tenant-1", "bad", { entity: {}, facts: {}, sources: {} } as unknown as FactManifest);
  } catch {
    rejected = true;
  }

  suite("contracts / store");

  test("save then load round-trips the manifest for its tenant", () => {
    assert(loaded !== null, "loaded is not null");
    assertEqual(loaded!.entity.companyName, manifest.entity.companyName, "same company round-trips");
  });

  test("a record saved under one tenant is invisible to another", () => {
    assertEqual(crossTenant, null, "tenant-2 sees nothing tenant-1 stored");
  });

  test("list returns a ref for the saved record", () => {
    assert(refs.some((r) => r.key === "meridian"), "the saved key is listed");
  });

  test("saving a contract-violating manifest is refused at the boundary", () => {
    assert(rejected, "an invalid manifest is rejected before it is stored");
  });
}
