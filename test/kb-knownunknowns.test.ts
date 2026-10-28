// test/kb-knownunknowns.test.ts
// The Module-2 known-unknowns / coverage-gap report (#3): the honest supportability surface for a
// master entity. The invariants under test are all about honesty, never invention:
//   (a) a concept with a live fact (turnover, cash) comes back supported, naming its sources;
//   (b) a concept with NO fact comes back a gap carrying a non-empty gapReason AND closesWith;
//   (c) with accountsType "filleted", a missing P&L line (operatingProfit) carries the
//       filleted-accounts reason, not the generic one;
//   (d) supportedCount + gapCount covers EVERY concept exactly once (=== CONCEPTS.length).
// In-memory only; async because the store interface is async, so the runner awaits the registrar.

import { suite, test, assert, assertEqual } from "./harness";
import { getKbStore, resetKbStoreForTests } from "../lib/kb/kbStore";
import { knownUnknowns } from "../lib/kb/knownUnknowns";
import { CONCEPTS } from "../lib/clientspec/concepts";
import type { KbFactRecord } from "../lib/kb/kbTypes";

// A minimal live fact for a lane; superseded is set by the store, so its seed value is irrelevant.
function fact(over: Partial<KbFactRecord> & Pick<KbFactRecord, "masterId" | "metric">): KbFactRecord {
  return {
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

export async function registerKbKnownUnknownsTests(): Promise<void> {
  suite("kb / known-unknowns");

  // Seed one entity with two held facts: turnover (companies-house) and cash (sec-edgar).
  resetKbStoreForTests();
  const store = getKbStore();
  const masterId = await store.resolveEntity({ name: "Acme PLC", lei: "LEI0000000000000ACME" });
  await store.upsertFact(fact({ masterId, metric: "turnover", source: "companies-house" }));
  await store.upsertFact(
    fact({ masterId, metric: "cash", source: "sec-edgar", docId: "sec-edgar:cash" })
  );

  const report = await knownUnknowns(store, masterId);
  const byConcept = new Map(report.items.map((i) => [i.concept, i]));

  // The same entity reported as filleted accounts, so the P&L gap reason is exercised (all awaits
  // happen here in the registrar; the sync test bodies below only assert over the results).
  const filletedReport = await knownUnknowns(store, masterId, { accountsType: "filleted" });

  // --- (a) supported concepts come back supported, naming their sources -----------------------
  test("a concept with a live fact is supported and names its source(s)", () => {
    const turnover = byConcept.get("turnover")!;
    assert(turnover.supported, "turnover is supported (a live fact is held)");
    assert(turnover.sources.includes("companies-house"), "turnover names its holding source");
    assertEqual(turnover.gapReason, undefined, "a supported concept carries no gapReason");
    assertEqual(turnover.closesWith, undefined, "a supported concept carries no closesWith");

    const cash = byConcept.get("cash")!;
    assert(cash.supported, "cash is supported");
    assert(cash.sources.includes("sec-edgar"), "cash names its holding source");
    assertEqual(cash.rung, "R1", "the held fact's rung is reported");
  });

  // --- (b) a concept with no fact is a gap carrying a reason AND what would close it -----------
  test("a concept with no held fact is a gap with a non-empty gapReason and closesWith", () => {
    const netDebt = byConcept.get("netDebt")!;
    assert(!netDebt.supported, "netDebt has no held fact, so it is a gap");
    assertEqual(netDebt.sources.length, 0, "a gap names no sources");
    assert(!!netDebt.gapReason && netDebt.gapReason.length > 0, "a gap carries a non-empty gapReason");
    assert(!!netDebt.closesWith && netDebt.closesWith.length > 0, "a gap says what would close it");
    assertEqual(netDebt.gapReason, "not reported by any held source", "the generic gap reason");
  });

  // --- (c) filleted accounts: a missing P&L line carries the filleted-accounts reason ---------
  test("with accountsType 'filleted', a missing operatingProfit carries the filleted reason", () => {
    const op = filletedReport.items.find((i) => i.concept === "operatingProfit")!;
    assert(!op.supported, "operatingProfit is not held, so it is a gap");
    assertEqual(
      op.gapReason,
      "UK filleted accounts carry no profit and loss account",
      "the P&L gap cites the filleted-accounts reason, not the generic one"
    );
    assertEqual(
      op.closesWith,
      "full statutory accounts or an entitled source (e.g. Octus)",
      "the P&L gap closes with full accounts or an entitled source"
    );
  });

  // --- (d) every concept is accounted for exactly once ----------------------------------------
  test("supportedCount + gapCount covers every concept exactly once", () => {
    assertEqual(report.items.length, CONCEPTS.length, "one item per concept");
    assertEqual(
      report.supportedCount + report.gapCount,
      CONCEPTS.length,
      "supported and gap partition the whole concept catalogue"
    );
    assertEqual(report.supportedCount, 2, "exactly the two seeded concepts are supported");
    assertEqual(report.entityName, "Acme PLC", "the report carries the entity's primary name");
  });
}
