// test/kb-exportpolicy.test.ts
// The export-policy engine (Module 2, #4): entitlement gating on the provenance envelope. All sync
// and deterministic, exposed via an async register fn to match the other suites.

import { suite, test, assert, assertEqual } from "./harness";
import type { Provenance } from "../lib/engine/types";
import {
  entitlementOf,
  canExport,
  partitionExportable,
  type Entitlement,
  type ExportContext,
} from "../lib/kb/exportPolicy";

// A minimal provenance envelope stamped with a given entitlement plane.
function prov(entitlement?: Entitlement): Provenance {
  return {
    sourceId: "src-1",
    tag: "Acc",
    documentName: "Annual report and accounts, y/e 31 Dec 2024",
    locator: "Note 4, p.18",
    snippet: "EBITDA 12.3",
    retrievedAt: "2026-01-01",
    contentHash: "hash-1",
    ...(entitlement ? { entitlement } : {}),
  };
}

export async function registerKbExportPolicyTests() {
  suite("kb-exportpolicy");

  // -- (d) entitlementOf ------------------------------------------------------

  test("entitlementOf defaults to public on null/undefined provenance", () => {
    assertEqual(entitlementOf(null), "public", "null -> public");
    assertEqual(entitlementOf(undefined), "public", "undefined -> public");
    assertEqual(entitlementOf(prov()), "public", "envelope without a tag -> public");
  });

  test("entitlementOf reads the tag when present", () => {
    assertEqual(entitlementOf(prov("entitled")), "entitled", "reads entitled");
    assertEqual(entitlementOf(prov("client")), "client", "reads client");
    assertEqual(entitlementOf(prov("public")), "public", "reads public");
  });

  // -- (a) public always exportable ------------------------------------------

  test("public is always exportable regardless of context", () => {
    const contexts: ExportContext[] = [
      { tenantId: "t1" },
      { tenantId: "t1", ownerTenantId: "t2" },
      { tenantId: "t1", hasEntitlement: false },
    ];
    for (const ctx of contexts) {
      const v = canExport("public", ctx);
      assert(v.allowed, "public allowed");
      assertEqual(v.reason, "public Tier-0 data", "public reason");
    }
  });

  // -- (b) entitled gated on the licence -------------------------------------

  test("entitled is blocked without hasEntitlement", () => {
    const v = canExport("entitled", { tenantId: "t1" });
    assert(!v.allowed, "entitled blocked when licence not held");
    assert(v.reason.includes("entitlement"), "reason names the missing entitlement");
  });

  test("entitled is allowed with hasEntitlement", () => {
    const v = canExport("entitled", { tenantId: "t1", hasEntitlement: true });
    assert(v.allowed, "entitled allowed when licence held");
  });

  test("entitled is blocked when hasEntitlement is explicitly false", () => {
    const v = canExport("entitled", { tenantId: "t1", hasEntitlement: false });
    assert(!v.allowed, "entitled blocked when licence explicitly withheld");
  });

  // -- (c) client stays in its owning tenant's silo --------------------------

  test("client is blocked cross-tenant", () => {
    const v = canExport("client", { tenantId: "t1", ownerTenantId: "t2" });
    assert(!v.allowed, "client blocked across tenants");
    assertEqual(
      v.reason,
      "client-supplied data cannot leave its owning tenant",
      "client cross-tenant reason"
    );
  });

  test("client is allowed same-tenant", () => {
    const v = canExport("client", { tenantId: "t1", ownerTenantId: "t1" });
    assert(v.allowed, "client allowed within its owning tenant");
  });

  test("client is blocked when no owner is recorded", () => {
    const v = canExport("client", { tenantId: "t1" });
    assert(!v.allowed, "client blocked when ownerTenantId is undefined (least exposure)");
  });

  // -- (e) partitionExportable splits a mixed list ---------------------------

  test("partitionExportable splits a mixed list correctly", () => {
    const ctx: ExportContext = { tenantId: "t1", ownerTenantId: "t1", hasEntitlement: false };
    const items = [
      { id: "a", provenance: prov("public") }, // public -> exportable
      { id: "b", entitlement: "entitled" as Entitlement }, // entitled, no licence -> blocked
      { id: "c", provenance: prov("client") }, // client, same tenant -> exportable
      { id: "d", provenance: null }, // untagged -> public -> exportable
      { id: "e", entitlement: "client" as Entitlement, provenance: prov("public") }, // explicit tag wins
    ];

    const { exportable, blocked } = partitionExportable(items, ctx);

    const exportableIds = exportable.map((i) => i.id).sort();
    const blockedIds = blocked.map((b) => b.item.id).sort();

    assertEqual(exportableIds.join(","), "a,c,d,e", "public + same-tenant client + untagged export");
    assertEqual(blockedIds.join(","), "b", "only the unlicensed entitled item is blocked");
    assertEqual(exportable.length + blocked.length, items.length, "every item is classified once");
  });

  test("partitionExportable prefers the explicit entitlement over provenance", () => {
    const ctx: ExportContext = { tenantId: "t1", ownerTenantId: "t2", hasEntitlement: false };
    // Explicit "entitled" tag overrides a public-looking provenance envelope.
    const items = [{ id: "x", entitlement: "entitled" as Entitlement, provenance: prov("public") }];
    const { exportable, blocked } = partitionExportable(items, ctx);
    assertEqual(exportable.length, 0, "explicit entitled tag gates the item");
    assertEqual(blocked.length, 1, "the item is blocked");
  });
}
