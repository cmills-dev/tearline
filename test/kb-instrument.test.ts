// test/kb-instrument.test.ts
// INSTRUMENTS on the Module-2 durable knowledge graph: a debt tranche or a registered charge
// accumulated on the master entity. Detected from a tranche/charge fact metric during ingest and
// upserted per source, so an instrument seen through two sources corroborates rather than
// overwrites. Three guarantees:
//   (a) ingesting a manifest whose facts carry an instrument metric surfaces the instrument via
//       listInstruments, with the right kind (tranche vs charge);
//   (b) upsertInstrument DEDUPS by (masterId, instrumentId, source): a re-ingest overwrites in place;
//   (c) the SAME instrument from a DIFFERENT source yields two rows (corroboration).
// In-memory only; async because the store interface is async, so the runner awaits the registrar.

import { suite, test, assert, assertEqual } from "./harness";
import { ingestManifest } from "../lib/kb/ingest";
import { getKbStore, resetKbStoreForTests } from "../lib/kb/kbStore";
import { buildManifest } from "../lib/engine/buildManifest";
import { meridian } from "../lib/sources/fixtures/meridian";
import type { Fact, FactManifest } from "../lib/engine/types";
import type { KbInstrument } from "../lib/kb/kbTypes";

// Clone a manifest and add a synthetic Companies-House-style charge fact (metric "charge1"), so the
// ingest path exercises the charge branch as well as the tranche facts meridian already carries.
function withCharge(base: FactManifest): FactManifest {
  const facts: Record<string, Fact> = { ...base.facts };
  const template = Object.values(base.facts)[0];
  const charge: Fact = {
    ...template,
    id: "charge1.FY2024",
    metric: "charge1",
    label: "Fixed and floating charge (Northbridge)",
    period: "FY2024",
    value: 1,
  };
  facts[charge.id] = charge;
  return { ...base, facts };
}

// A minimal instrument record, with an overridable source, for the direct upsert tests.
function instrument(over: Partial<KbInstrument> & Pick<KbInstrument, "masterId">): KbInstrument {
  return {
    instrumentId: "charge1",
    kind: "charge",
    label: "Fixed and floating charge",
    metric: "charge1",
    source: "companies-house",
    asOf: "2024-12-31",
    entitlement: "public",
    ...over,
  };
}

export async function registerKbInstrumentTests(): Promise<void> {
  suite("kb / instrument");

  // -- (a) ingest surfaces instruments with the right kind ------------------
  resetKbStoreForTests();
  const storeA = getKbStore();
  const manifestA = withCharge(buildManifest(meridian));
  const summaryA = await ingestManifest(storeA, manifestA, "companies-house");
  const instrumentsA = await storeA.listInstruments(summaryA.masterId);
  const charge = instrumentsA.find((i) => i.instrumentId === "charge1");
  const tranche = instrumentsA.find((i) => i.instrumentId === "trancheTermLoan");

  test("(a) ingesting a manifest with instrument metrics accumulates them with the right kind", () => {
    assert(instrumentsA.length > 0, "listInstruments is non-empty after ingest");
    assert(!!charge, "the charge1 metric surfaced as an instrument");
    assertEqual(charge!.kind, "charge", "a charge<n> metric is detected as a charge");
    assert(!!tranche, "the trancheTermLoan metric surfaced as an instrument");
    assertEqual(tranche!.kind, "tranche", "a tranche metric is detected as a tranche");
    assert(instrumentsA.every((i) => i.masterId === summaryA.masterId), "all hang off the entity");
    assert(instrumentsA.every((i) => i.entitlement === "public"), "public plane tag carries through");
  });

  // -- (b) upsertInstrument dedups by (masterId, instrumentId, source) ------
  resetKbStoreForTests();
  const storeB = getKbStore();
  const idB = await storeB.resolveEntity({ name: "Bravo Ltd", lei: "LEI0000000000000BRAVO" });
  await storeB.upsertInstrument(instrument({ masterId: idB, label: "first label" }));
  await storeB.upsertInstrument(instrument({ masterId: idB, label: "second label" }));
  const instrumentsB = await storeB.listInstruments(idB);

  test("(b) upsertInstrument dedups by (masterId, instrumentId, source), overwriting in place", () => {
    assertEqual(instrumentsB.length, 1, "the same instrument from the same source is one row");
    assertEqual(instrumentsB[0].label, "second label", "the re-ingest overwrote in place");
  });

  // -- (c) the same instrument from two sources yields two rows -------------
  resetKbStoreForTests();
  const storeC = getKbStore();
  const idC = await storeC.resolveEntity({ name: "Charlie PLC", lei: "LEI0000000000000CHARL" });
  await storeC.upsertInstrument(instrument({ masterId: idC, source: "companies-house" }));
  await storeC.upsertInstrument(instrument({ masterId: idC, source: "sec-edgar" }));
  const instrumentsC = await storeC.listInstruments(idC);

  test("(c) the same instrument from two sources corroborates: two rows, one per source", () => {
    assertEqual(instrumentsC.length, 2, "distinct sources each keep a row");
    const sources = instrumentsC.map((i) => i.source).sort();
    assertEqual(sources.join(","), "companies-house,sec-edgar", "both sources are present");
  });

  // -- (d) a merge that collides on an instrument's natural key dedups, never duplicates --------
  resetKbStoreForTests();
  const storeD = getKbStore();
  // Two separate entities, each holding the SAME instrument from the SAME source.
  const chOnly = await storeD.resolveEntity({ name: "Delta Ltd", chNumber: "SC900001" });
  await storeD.upsertInstrument(instrument({ masterId: chOnly, source: "companies-house" }));
  const leiOnly = await storeD.resolveEntity({ name: "Delta Ltd", lei: "LEI0000000000000DELTA" });
  await storeD.upsertInstrument(instrument({ masterId: leiOnly, source: "companies-house" }));
  // A record carrying BOTH ids bridges them into one entity.
  const merged = await storeD.resolveEntity({ name: "Delta Ltd", chNumber: "SC900001", lei: "LEI0000000000000DELTA" });
  const instrumentsD = await storeD.listInstruments(merged);

  test("(d) a merge colliding on an instrument's natural key dedups to one row, never two", () => {
    assertEqual(instrumentsD.length, 1, "the duplicate (charge1, companies-house) collapses on merge");
    assertEqual(instrumentsD[0].masterId, merged, "the surviving row hangs off the merged entity");
  });
}
