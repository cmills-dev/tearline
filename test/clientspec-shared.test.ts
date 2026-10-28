// test/clientspec-shared.test.ts
// The RSI Phases 2 to 3 SHARED-PLANE store: cross-tenant, de-identified vocabulary learning. This
// store lives outside the tenant RLS wall, so the invariant under test is that it counts DISTINCT
// tenants (deduped by a one-way hash) without ever exposing a raw tenant id. We check: one tenant
// contributing twice is idempotent, two tenants count as two, the minTenants filter, status round
// trips, promotion bumps the version and drives activeEntries/activeVersion, and no method leaks a
// raw tenant id. In-memory only; async because the store interface is async, so the runner awaits
// the registrar before the harness.

import { suite, test, assert, assertEqual } from "./harness";
import { getSharedLearningStore, resetSharedLearningStoreForTests } from "../lib/clientspec/sharedStore";

export async function registerClientSpecSharedTests(): Promise<void> {
  suite("clientspec / shared");

  // --- (a) one tenant contributing twice is idempotent ---------------------
  resetSharedLearningStoreForTests();
  const s1 = getSharedLearningStore();
  await s1.contribute("adj ebitda", "concept:ebitda", "tenant-a");
  await s1.contribute("adj ebitda", "concept:ebitda", "tenant-a");
  const oneTenant = await s1.listCandidates();
  test("a tenant confirming twice keeps distinctTenants at 1 (idempotent dedup)", () => {
    assertEqual(oneTenant.length, 1, "the one confirmed mapping is a single candidate");
    assertEqual(oneTenant[0].distinctTenants, 1, "the same tenant is deduped by its hash");
    assertEqual(oneTenant[0].status, "pending", "a fresh candidate starts pending");
    assertEqual(oneTenant[0].labelNorm, "adj ebitda", "the normalised label round-trips");
    assertEqual(oneTenant[0].conceptKey, "concept:ebitda", "the concept key round-trips");
  });

  // --- (b) two different tenants -> distinctTenants = 2 --------------------
  resetSharedLearningStoreForTests();
  const s2 = getSharedLearningStore();
  await s2.contribute("net debt", "concept:netdebt", "tenant-a");
  await s2.contribute("net debt", "concept:netdebt", "tenant-b");
  const twoTenants = await s2.listCandidates();
  test("two distinct tenants confirming the same mapping count as 2", () => {
    assertEqual(twoTenants.length, 1, "the same mapping stays one candidate");
    assertEqual(twoTenants[0].distinctTenants, 2, "two distinct tenant hashes count as two");
  });

  // --- (c) listCandidates(minTenants) filters ------------------------------
  resetSharedLearningStoreForTests();
  const s3 = getSharedLearningStore();
  await s3.contribute("net debt", "concept:netdebt", "tenant-a");
  await s3.contribute("net debt", "concept:netdebt", "tenant-b");
  await s3.contribute("adj ebitda", "concept:ebitda", "tenant-a"); // only one tenant
  const filtered = await s3.listCandidates(2);
  test("listCandidates(minTenants:2) keeps only mappings with >= 2 distinct tenants", () => {
    assertEqual(filtered.length, 1, "only the two-tenant mapping passes the filter");
    assertEqual(filtered[0].labelNorm, "net debt", "the surviving candidate is the two-tenant one");
    assertEqual(filtered[0].distinctTenants, 2, "its distinct count is 2");
  });

  // --- (d) setCandidateStatus round-trips ----------------------------------
  resetSharedLearningStoreForTests();
  const s4 = getSharedLearningStore();
  await s4.contribute("gross profit", "concept:grossprofit", "tenant-a");
  await s4.setCandidateStatus("gross profit", "concept:grossprofit", "queued");
  const afterStatus = await s4.listCandidates();
  test("setCandidateStatus updates the candidate and does not disturb its count", () => {
    assertEqual(afterStatus.length, 1, "still a single candidate");
    assertEqual(afterStatus[0].status, "queued", "the new status round-trips");
    assertEqual(afterStatus[0].distinctTenants, 1, "changing status leaves the count untouched");
  });

  // --- (d2) contribute does not downgrade an existing status ---------------
  await s4.contribute("gross profit", "concept:grossprofit", "tenant-b");
  const afterRecontribute = await s4.listCandidates();
  test("a later contribute keeps a set status (never downgrades to pending)", () => {
    assertEqual(afterRecontribute[0].status, "queued", "the queued status survives a new contribution");
    assertEqual(afterRecontribute[0].distinctTenants, 2, "the new tenant still counts");
  });

  // --- (e) promote bumps version; activeEntries/activeVersion reflect latest -
  resetSharedLearningStoreForTests();
  const s5 = getSharedLearningStore();
  const v0 = await s5.activeVersion();
  const e0 = await s5.activeEntries();
  const v1 = await s5.promote([{ labelNorm: "net debt", conceptKey: "concept:netdebt" }], "analyst-1");
  const v2 = await s5.promote(
    [
      { labelNorm: "net debt", conceptKey: "concept:netdebt" },
      { labelNorm: "adj ebitda", conceptKey: "concept:ebitda" },
    ],
    "analyst-2",
  );
  const activeV = await s5.activeVersion();
  const activeE = await s5.activeEntries();
  const versions = await s5.listVersions();
  test("promote appends versions; activeVersion/activeEntries track the latest", () => {
    assertEqual(v0, 0, "activeVersion is 0 before any promotion");
    assertEqual(e0.length, 0, "activeEntries is empty before any promotion");
    assertEqual(v1, 1, "the first promotion is version 1");
    assertEqual(v2, 2, "the second promotion is version 2");
    assertEqual(activeV, 2, "activeVersion is the max version");
    assertEqual(activeE.length, 2, "activeEntries are the latest version's entries");
    assertEqual(activeE[1].labelNorm, "adj ebitda", "the latest entries are served");
    assertEqual(versions.length, 2, "both versions are listed");
    assertEqual(versions[0].version, 2, "listVersions is newest first");
    assertEqual(versions[0].approvedBy, "analyst-2", "the approver round-trips");
  });

  // --- (f) no raw tenant id is retrievable from any method -----------------
  resetSharedLearningStoreForTests();
  const s6 = getSharedLearningStore();
  const secretTenant = "tenant-secret-xyz";
  await s6.contribute("operating cash flow", "concept:ocf", secretTenant);
  await s6.setCandidateStatus("operating cash flow", "concept:ocf", "approved");
  await s6.promote([{ labelNorm: "operating cash flow", conceptKey: "concept:ocf" }], "analyst-3");
  const leakCandidates = await s6.listCandidates();
  const dump = JSON.stringify({
    candidates: leakCandidates,
    versions: await s6.listVersions(),
    entries: await s6.activeEntries(),
  });
  test("no method leaks a raw tenant id; only de-identified counts are exposed", () => {
    assert(!dump.includes(secretTenant), "the raw tenant id never appears in any store output");
    const cand = leakCandidates[0];
    assertEqual(cand.distinctTenants, 1, "the tenant is represented only as a count");
    assert(!("tenantId" in cand) && !("tenantHash" in cand), "a candidate exposes no tenant field");
  });
}
