// test/kb-ingest.test.ts
// The ingest pipeline (lib/kb/ingest.ts) is what turns a per-manifest tear sheet into durable,
// cross-source knowledge. Three guarantees:
//   (a) a manifest resolves to ONE master entity and its facts accumulate under it;
//   (b) CROSS-SOURCE MERGE: the same company seen through two sources (a shared LEI) lands on ONE
//       master id, and its coverage shows facts sourced from both;
//   (c) AMENDMENT PRECEDENCE: a newer filing supersedes an older value for the same metric, while
//       the older value is retained for lineage under includeSuperseded.
// Async because the store interface is async; the runner awaits the registrar, so all ingest work
// happens here and the assertions read captured results (matching the other suites' shape).

import { suite, test, assert, assertEqual } from "./harness";
import { ingestManifest, asOfForFact, asOfForManifest } from "../lib/kb/ingest";
import { getKbStore, resetKbStoreForTests } from "../lib/kb/kbStore";
import { buildManifest } from "../lib/engine/buildManifest";
import { meridian } from "../lib/sources/fixtures/meridian";
import type { Fact, FactManifest } from "../lib/engine/types";

// Reduce a manifest to a single, yearless period. A fact's effective date now derives from the
// manifest's FILING date (`generatedAt`, the as-reported proxy), so a later filing supersedes an
// earlier one for the SAME (metric, period) only when it carries a strictly later generatedAt. The
// latestPeriodEnd is kept realistic per filing but no longer drives precedence.
function latestOnly(
  base: FactManifest,
  latestPeriodEnd: string,
  turnoverValue: number,
  generatedAt: string
): FactManifest {
  const facts: Record<string, Fact> = {};
  for (const f of Object.values(base.facts)) {
    if (f.period !== "FY2024") continue;
    const period = "Latest";
    const value = f.metric === "turnover" ? turnoverValue : f.value;
    const nf: Fact = { ...f, period, id: `${f.metric}.${period}`, value };
    facts[nf.id] = nf;
  }
  return { ...base, facts, generatedAt, entity: { ...base.entity, latestPeriodEnd } };
}

export async function registerKbIngestTests(): Promise<void> {
  suite("kb / ingest");

  const base = buildManifest(meridian);

  // -- (a) resolve + accumulate ---------------------------------------------
  resetKbStoreForTests();
  const storeA = getKbStore();
  const summaryA = await ingestManifest(storeA, buildManifest(meridian), "companies-house");
  const factsA = await storeA.listFacts(summaryA.masterId);
  const coverageA = await storeA.coverage(summaryA.masterId);

  // -- (b) cross-source merge on a shared LEI -------------------------------
  resetKbStoreForTests();
  const storeB = getKbStore();
  const LEI = "969500MERIDIANILLUS00"; // fixed, shared by both manifests so they merge
  const chManifest: FactManifest = { ...base, entity: { ...base.entity, lei: LEI } };
  const esefManifest: FactManifest = { ...base, entity: { ...base.entity, lei: LEI } };
  const sumCH = await ingestManifest(storeB, chManifest, "companies-house");
  const sumEsef = await ingestManifest(storeB, esefManifest, "esef");
  const coverageB = await storeB.coverage(sumCH.masterId);
  const coverageSourcesB = new Set<string>();
  for (const item of coverageB.items) for (const s of item.sources) coverageSourcesB.add(s);

  // -- (c) amendment precedence ---------------------------------------------
  resetKbStoreForTests();
  const storeC = getKbStore();
  // The restatement (v2) is a strictly LATER filing of the same period: same period key ("Latest"),
  // a newer generatedAt drives precedence so it supersedes v1's value.
  const v1 = latestOnly(base, "2024-12-31", 48_200_000, "2024-01-15T00:00:00.000Z");
  const v2 = latestOnly(base, "2025-12-31", 55_000_000, "2025-01-15T00:00:00.000Z"); // newer filing
  const sumV1 = await ingestManifest(storeC, v1, "companies-house");
  const sumV2 = await ingestManifest(storeC, v2, "companies-house");
  const liveC = await storeC.listFacts(sumV2.masterId);
  const allC = await storeC.listFacts(sumV2.masterId, { includeSuperseded: true });
  const liveTurnover = liveC.find((f) => f.metric === "turnover" && f.period === "Latest");
  const olderTurnover = allC.find(
    (f) => f.metric === "turnover" && f.period === "Latest" && f.value === 48_200_000
  );

  // -------------------------------------------------------------------------

  test("(a) ingesting the meridian manifest creates an entity and accumulates its facts", () => {
    assert(summaryA.masterId.length > 0, "a master id was returned");
    assertEqual(summaryA.entityName, meridian.displayName, "entity name carries through");
    assert(summaryA.factsIngested > 0, "at least one fact was ingested");
    assertEqual(summaryA.documentsIngested, 3, "all three source documents ingested");
    assert(factsA.length > 0, "listFacts is non-empty");
    assert(coverageA.items.length > 0, "coverage lists metrics");
    assert(coverageA.items.every((i) => i.metric.length > 0), "each coverage item names a metric");
  });

  test("(b) two sources for the same entity merge to ONE master id, coverage shows both", () => {
    assertEqual(sumCH.masterId, sumEsef.masterId, "both ingests resolve to the same master id");
    assertEqual(sumCH.masterId, `lei:${LEI}`, "the shared LEI is the master-id spine");
    assert(coverageSourcesB.has("companies-house"), "coverage carries companies-house facts");
    assert(coverageSourcesB.has("esef"), "coverage carries esef facts");
  });

  test("(c) a newer filing supersedes the older value; the older is retained for lineage", () => {
    assertEqual(sumV1.masterId, sumV2.masterId, "both filings resolve to the same entity");
    assert(!!liveTurnover, "a live turnover fact exists");
    assertEqual(liveTurnover!.value, 55_000_000, "the live value is the newer one");
    assertEqual(liveTurnover!.superseded, false, "the live fact is not superseded");
    assert(
      liveC.every((f) => !(f.metric === "turnover" && f.period === "Latest" && f.value === 48_200_000)),
      "the older value is not live"
    );
    assert(!!olderTurnover, "the older value is retained under includeSuperseded");
    assertEqual(olderTurnover!.superseded, true, "the retained older fact is marked superseded");
  });

  test("(d) asOf prefers the as-reported filing date over the capture time, so a re-fetch cannot supersede a restatement", () => {
    const base = buildManifest(meridian);
    const withFiling: FactManifest = {
      ...base,
      generatedAt: "2026-01-15", // capture time (later)
      entity: { ...base.entity, asReportedAt: "2024-11-01", latestPeriodEnd: "2024-12-31" },
    };
    const anyFact = Object.values(withFiling.facts)[0] as Fact;
    assertEqual(asOfForFact(anyFact, withFiling), "2024-11-01", "fact asOf is the filing date, not the capture time");
    assertEqual(asOfForManifest(withFiling), "2024-11-01", "document asOf is the filing date too");
    // Without a filing date, it falls back to the capture time exactly as before (unchanged behaviour).
    const noFiling: FactManifest = { ...base, generatedAt: "2026-01-15", entity: { ...base.entity, asReportedAt: undefined } };
    assertEqual(asOfForFact(anyFact, noFiling), "2026-01-15", "falls back to capture time when no filing date is threaded");
  });
}
