// test/kb-store.test.ts
// The Module-2 durable knowledge-graph store: the master-ID entity spine and cross-source fact
// accumulation with amendment precedence. This plane is GLOBAL (shared Tier-0, no tenant scoping),
// so the invariants under test are all resolution/precedence, never tenant isolation:
//   (a) two records sharing a join key (LEI) resolve to ONE master entity, not a duplicate;
//   (b) a record carrying BOTH a CH and an LEI bridges two previously-separate entities into one,
//       carrying their facts across;
//   (c) amendment precedence: a newer asOf supersedes the older; an older asOf never overwrites;
//   (d) coverage lists a metric held by two sources, naming both.
// In-memory only; async because the store interface is async, so the runner awaits the registrar.

import { suite, test, assert, assertEqual } from "./harness";
import { getKbStore, resetKbStoreForTests } from "../lib/kb/kbStore";
import type { KbFactRecord } from "../lib/kb/kbTypes";

// A minimal live fact for a lane, with an overridable asOf/value/source. superseded is set by the
// store, so the seed value here is irrelevant.
function fact(over: Partial<KbFactRecord> & Pick<KbFactRecord, "masterId">): KbFactRecord {
  return {
    metric: "revenue",
    period: "FY2024",
    value: 1000,
    kind: "currency",
    unit: "GBP",
    rung: "R1",
    source: "companies-house",
    docId: "companies-house:doc-1",
    asOf: "2025-01-01T00:00:00.000Z",
    entitlement: "public",
    provenance: null,
    superseded: false,
    ingestedAt: new Date().toISOString(),
    ...over,
  };
}

export async function registerKbStoreTests(): Promise<void> {
  suite("kb / store");

  // --- (a) resolve is find-or-create: a shared LEI returns the SAME master id ----------------
  resetKbStoreForTests();
  const a = getKbStore();
  const idA1 = await a.resolveEntity({ name: "Acme PLC", lei: "LEI0000000000000ACME" });
  const idA2 = await a.resolveEntity({ name: "Acme Public Limited", lei: "LEI0000000000000ACME" });
  const entitiesA = await a.listEntities();
  test("resolveEntity de-duplicates: a second record sharing the LEI returns the same masterId", () => {
    assertEqual(idA1, idA2, "the shared LEI resolves to the one master entity");
    assertEqual(entitiesA.length, 1, "no duplicate entity was created");
    assert(entitiesA[0].names.includes("Acme PLC"), "the first name is retained");
    assert(entitiesA[0].names.includes("Acme Public Limited"), "the second name is merged in");
  });

  // --- (b) a bridging record merges two separate entities, carrying facts across --------------
  resetKbStoreForTests();
  const b = getKbStore();
  // One entity seen ONLY by CH number, with a fact.
  const chOnly = await b.resolveEntity({ name: "Bravo Ltd", chNumber: "01234567" });
  await b.upsertFact(fact({ masterId: chOnly, metric: "revenue", source: "companies-house" }));
  // A separate entity seen ONLY by LEI, with a different fact.
  const leiOnly = await b.resolveEntity({ name: "Bravo Ltd", lei: "LEI0000000000000BRAVO" });
  await b.upsertFact(fact({ masterId: leiOnly, metric: "ebitda", source: "sec-edgar", docId: "sec-edgar:doc-1" }));
  test("two entities sharing only a name stay separate until a real join key bridges them", () => {
    assert(chOnly !== leiOnly, "a shared name alone does NOT merge them");
  });
  // A record carrying BOTH identifiers bridges them.
  const bridged = await b.resolveEntity({
    name: "Bravo Ltd",
    chNumber: "01234567",
    lei: "LEI0000000000000BRAVO",
  });
  const entitiesB = await b.listEntities();
  const survivorFacts = await b.listFacts(bridged);
  test("a record carrying both a CH and an LEI merges the two entities, carrying facts across", () => {
    assertEqual(entitiesB.length, 1, "the two entities collapse into one survivor");
    assertEqual(bridged, entitiesB[0].masterId, "resolve returns the survivor's masterId");
    // LEI is the strongest id, so the survivor is the LEI-keyed one.
    assertEqual(bridged, leiOnly, "the stronger LEI-keyed id wins as survivor");
    const metrics = survivorFacts.map((f) => f.metric).sort();
    assertEqual(metrics.join(","), "ebitda,revenue", "both entities' facts now hang off the survivor");
  });

  // --- (c) amendment precedence -------------------------------------------------------------
  resetKbStoreForTests();
  const c = getKbStore();
  const idC = await c.resolveEntity({ name: "Charlie PLC", lei: "LEI0000000000000CHARL" });
  // Establish an older live fact (a source's original filing).
  await c.upsertFact(fact({ masterId: idC, value: 100, asOf: "2024-06-30T00:00:00.000Z", source: "companies-house", docId: "companies-house:orig" }));
  // The SAME source amends it with a newer asOf: the restatement supersedes the original.
  await c.upsertFact(fact({ masterId: idC, value: 200, asOf: "2025-06-30T00:00:00.000Z", source: "companies-house", docId: "companies-house:amend" }));
  const liveAfterNewer = await c.listFacts(idC);
  const allAfterNewer = await c.listFacts(idC, { includeSuperseded: true });
  test("a newer asOf supersedes the older: live shows the new value, lineage keeps both", () => {
    assertEqual(liveAfterNewer.length, 1, "exactly one live fact for the lane");
    assertEqual(liveAfterNewer[0].value, 200, "the live fact is the newer-asOf value");
    assertEqual(allAfterNewer.length, 2, "includeSuperseded returns both records");
    const superseded = allAfterNewer.filter((f) => f.superseded);
    assertEqual(superseded.length, 1, "the older fact is retained as superseded");
    assertEqual(superseded[0].value, 100, "the superseded record is the older-asOf value");
  });
  // An OLDER (stale) restatement from the same source must NOT overwrite the newer live fact.
  await c.upsertFact(fact({ masterId: idC, value: 50, asOf: "2023-06-30T00:00:00.000Z", source: "companies-house", docId: "companies-house:stale" }));
  const liveAfterStale = await c.listFacts(idC);
  const allAfterStale = await c.listFacts(idC, { includeSuperseded: true });
  test("an older/equal asOf never overwrites the newer live fact but is kept for lineage", () => {
    assertEqual(liveAfterStale.length, 1, "still exactly one live fact");
    assertEqual(liveAfterStale[0].value, 200, "the live value is unchanged (stale record ignored)");
    assertEqual(allAfterStale.length, 3, "the stale record is retained (never lost)");
  });

  // --- (d) coverage names every source holding a live metric --------------------------------
  resetKbStoreForTests();
  const d = getKbStore();
  const idD = await d.resolveEntity({ name: "Delta Ltd", lei: "LEI0000000000000DELTA" });
  // Same metric+period held live by two different sources (different lanes require different
  // periods, so use two periods each carried by both sources to exercise a two-source coverage).
  await d.upsertFact(fact({ masterId: idD, metric: "revenue", period: "FY2024", source: "companies-house", asOf: "2025-01-01T00:00:00.000Z" }));
  await d.upsertFact(fact({ masterId: idD, metric: "revenue", period: "FY2024", source: "sec-edgar", docId: "sec-edgar:rev", asOf: "2025-02-01T00:00:00.000Z" }));
  const cov = await d.coverage(idD);
  test("coverage lists a metric held by two sources, naming both, with the freshest asOf", () => {
    assertEqual(cov.items.length, 1, "one coverage item for the single live metric/period");
    const item = cov.items[0];
    assertEqual(item.metric, "revenue", "the metric is reported");
    assert(item.sources.includes("companies-house"), "the first source is listed");
    assert(item.sources.includes("sec-edgar"), "the second source is listed");
    assertEqual(item.asOf, "2025-02-01T00:00:00.000Z", "the freshest asOf across sources is reported");
    assertEqual(cov.sourceCount, 2, "sourceCount counts both distinct sources");
    assertEqual(cov.entityName, "Delta Ltd", "coverage carries the entity's primary name");
  });

  // --- (e) merge reconciles a shared fact lane ----------------------------------------------
  // Two previously-separate entities EACH hold a live fact for the SAME (metric, period, source)
  // lane, at different asOf. A bridging record merges them; without reconciliation the survivor
  // would end with TWO live facts in one lane. The merge must leave exactly ONE live (the newest),
  // the other retained as superseded (never deleted).
  resetKbStoreForTests();
  const e = getKbStore();
  const eCh = await e.resolveEntity({ name: "Echo Ltd", chNumber: "07654321" });
  await e.upsertFact(fact({ masterId: eCh, metric: "revenue", period: "FY2024", source: "companies-house", value: 100, asOf: "2024-06-30T00:00:00.000Z" }));
  const eLei = await e.resolveEntity({ name: "Echo Ltd", lei: "LEI0000000000000ECHO0" });
  await e.upsertFact(fact({ masterId: eLei, metric: "revenue", period: "FY2024", source: "companies-house", value: 200, asOf: "2025-06-30T00:00:00.000Z" }));
  const eBridged = await e.resolveEntity({ name: "Echo Ltd", chNumber: "07654321", lei: "LEI0000000000000ECHO0" });
  const eLive = await e.listFacts(eBridged);
  const eAll = await e.listFacts(eBridged, { includeSuperseded: true });
  test("merging two entities that both hold a live fact in one lane reconciles to a single live fact", () => {
    const liveLane = eLive.filter((f) => f.metric === "revenue" && f.period === "FY2024" && f.source === "companies-house");
    assertEqual(liveLane.length, 1, "exactly ONE live fact remains in the shared lane after merge");
    assertEqual(liveLane[0].value, 200, "the newest-asOf fact stays live");
    const allLane = eAll.filter((f) => f.metric === "revenue" && f.period === "FY2024" && f.source === "companies-house");
    assertEqual(allLane.length, 2, "both records are retained for lineage");
    assertEqual(allLane.filter((f) => f.superseded).length, 1, "the older record is marked superseded, not deleted");
    assertEqual(allLane.find((f) => f.superseded)!.value, 100, "the older-asOf value is the one superseded");
  });

  // --- (f) the shared Tier-0 plane is public-only: a non-public write is refused ---------------
  resetKbStoreForTests();
  const f2 = getKbStore();
  const pubId = await f2.resolveEntity({ name: "Foxtrot Ltd", chNumber: "09999999" });
  let entitledRejected = false;
  try {
    await f2.upsertFact(fact({ masterId: pubId, entitlement: "entitled" }));
  } catch {
    entitledRejected = true;
  }
  let clientRejected = false;
  try {
    await f2.upsertFact(fact({ masterId: pubId, entitlement: "client" }));
  } catch {
    clientRejected = true;
  }
  test("the shared Tier-0 plane refuses a non-public fact (fail closed)", () => {
    assert(entitledRejected, "an entitled fact is refused from the public plane");
    assert(clientRejected, "a client-silo fact is refused from the public plane");
  });
}
