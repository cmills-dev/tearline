// test/kb.test.ts
// Tests for the knowledge-base engine spine (lib/kb): the graph store, the query/coverage
// surface, and the checking engine (structural identities, contradictions, corroboration).
// All sync and deterministic, so they register on a bare import.

import { suite, test, assert, assertEqual } from "./harness";
import type { Fact, Provenance, ProvenanceTag, Rung } from "../lib/engine/types";
import { buildManifest } from "../lib/engine/buildManifest";
import { meridian } from "../lib/sources/fixtures/meridian";
import { redacta } from "../lib/sources/fixtures/redacta";
import { KnowledgeGraph } from "../lib/kb/graph";
import { factsFor, sortFacts, coverage, provenanceTier } from "../lib/kb/query";
import {
  runEnrichedChecks,
  detectContradictions,
  corroborationState,
} from "../lib/kb/check";

// --- small fact factory for crafted cross-source cases ---
function mkFact(
  metric: string,
  period: string,
  value: number | null,
  sourceId: string | null,
  tag: ProvenanceTag = "Acc",
  rung: Rung = "R1"
): Fact {
  const provenance: Provenance | null = sourceId
    ? {
        sourceId,
        tag,
        documentName: `${sourceId} document`,
        locator: "p.1",
        snippet: `${metric} ${value}`,
        retrievedAt: "2026-07-28",
        contentHash: "hash",
      }
    : null;
  return {
    id: `${metric}.${period}`,
    metric,
    label: metric,
    period,
    kind: "currency",
    value,
    unit: "GBP",
    rung,
    provenance,
    verification: { status: sourceId ? "SINGLE_SOURCE" : "NOT_APPLICABLE", checks: [] },
  };
}

suite("kb/graph");

test("ingestManifest builds the expected nodes and edges from meridian", () => {
  const manifest = buildManifest(meridian);
  const kb = new KnowledgeGraph();
  const g = kb.ingestManifest("tenant-a", manifest);

  // One entity, the illustrative Meridian company.
  const entities = g.entities();
  assertEqual(entities.length, 1, "exactly one entity node");
  assertEqual(entities[0].companyNumber, "SC000000", "entity keyed by company number");

  // Three source documents (2024 accounts, 2023 accounts, charges register).
  assertEqual(g.documents("SC000000").length, 3, "three document nodes for meridian");

  // Two instruments, from the two tranche facts.
  const instMetrics = g.instruments("SC000000").map((i) => i.metric).sort();
  assertEqual(instMetrics.join(","), "trancheRcf,trancheTermLoan", "two tranche instruments");

  // The term-loan fact is linked to its instrument.
  const termFactNodeId = `FACT:SC000000:trancheTermLoan.FY2024`;
  const termInstId = `INSTRUMENT:SC000000:trancheTermLoan`;
  const hasInstEdge = g.edges.some(
    (e) => e.rel === "FACT_OF_INSTRUMENT" && e.from === termFactNodeId && e.to === termInstId
  );
  assert(hasInstEdge, "term-loan fact links to its instrument node");

  // Every fact links to the entity carrying its period.
  const ndEdge = g.edges.find(
    (e) => e.rel === "FACT_OF_ENTITY" && e.from === "FACT:SC000000:netDebt.FY2024"
  );
  assert(!!ndEdge && ndEdge.period === "FY2024", "fact->entity edge carries the period");

  // Tenancy: another tenant sees nothing.
  assertEqual(kb.tenant("tenant-b"), undefined, "other tenant is empty");
});

suite("kb/query");

test("coverage buckets resolved vs abstained vs missing on redacta", () => {
  const manifest = buildManifest(redacta);
  const report = coverage(manifest, {
    entity: "12000000",
    period: "FY2024",
    required: [
      "cash", // R1 reported
      "totalAssets", // R1 reported
      "turnover", // R4 abstain (filleted, not filed)
      "ebitda", // R3 proxy on EBIT
      "netDebt", // R2 synthesised
      "leverage", // R2 synthesised
      "interestCover", // R4 abstain (no net interest line)
      "grossProfit", // not present at all
    ],
  });

  assertEqual(report.resolved.sort().join(","), "cash,ebitda,leverage,netDebt,totalAssets", "resolved bucket");
  assertEqual(report.abstained.sort().join(","), "interestCover,turnover", "abstained bucket");
  assertEqual(report.missing.join(","), "grossProfit", "missing bucket");
  assertEqual(report.counts.resolved, 5, "five resolved");
  assertEqual(Math.round(report.ratio * 1000) / 1000, 0.625, "coverage ratio 5/8");
});

test("sortFacts orders by rung then tier", () => {
  const facts: Fact[] = [
    mkFact("a", "FY2024", 4, "s1", "Acc", "R4"),
    mkFact("b", "FY2024", 2, "s1", "Acc", "R2"),
    mkFact("c", "FY2024", 1, "s1", "Acc", "R1"),
    mkFact("d", "FY2024", 3, "s1", "Acc", "R3"),
  ];
  const ordered = sortFacts(facts, "rung").map((f) => f.rung);
  assertEqual(ordered.join(","), "R1,R2,R3,R4", "best rung first");

  // Same rung, different source tier: Acc (P1) sorts before Web (P5).
  const sameRung: Fact[] = [
    mkFact("x", "FY2024", 1, "web", "Web", "R1"),
    mkFact("y", "FY2024", 1, "acc", "Acc", "R1"),
  ];
  const tiered = sortFacts(sameRung, "rung").map((f) => provenanceTier(f.provenance));
  assertEqual(tiered.join(","), "P1,P5", "within a rung, best tier first");
});

test("factsFor honours minRung", () => {
  const manifest = buildManifest(redacta);
  // minRung R3 must exclude the R4 abstains (turnover, interestCover).
  const upToR3 = factsFor(manifest, { entity: "12000000", period: "FY2024", minRung: "R3" });
  assert(upToR3.every((f) => f.rung !== "R4"), "minRung R3 excludes abstains");
  const turnover = factsFor(manifest, { entity: "12000000", metric: "turnover" });
  assertEqual(turnover.length, 1, "turnover fact exists");
  assertEqual(turnover[0].rung, "R4", "turnover is an R4 abstain");
});

suite("kb/check");

test("a structural identity passes on meridian", () => {
  const manifest = buildManifest(meridian);
  const checks = runEnrichedChecks(manifest.facts, "FY2024");
  const netDebt = checks.find((c) => c.id === "net-debt.FY2024");
  assert(!!netDebt, "net debt check ran");
  assert(netDebt!.passed, `net debt reconciles: ${netDebt!.detail}`);
  const ebitda = checks.find((c) => c.id === "ebitda.FY2024");
  assert(!!ebitda && ebitda.passed, "EBITDA reconciles from EBIT + D&A");
});

test("a contradiction is detected on a crafted disagreeing pair", () => {
  const disagree = [
    mkFact("ebitda", "FY2024", 8_700_000, "source-x"),
    mkFact("ebitda", "FY2024", 6_000_000, "source-y"),
  ];
  const found = detectContradictions(disagree);
  assertEqual(found.length, 1, "one contradiction");
  assertEqual(found[0].metric, "ebitda", "on the ebitda metric");
  assert(found[0].spread === 2_700_000, "spread is max - min");

  // An agreeing pair produces no contradiction.
  const agree = [
    mkFact("ebitda", "FY2024", 8_700_000, "source-x"),
    mkFact("ebitda", "FY2024", 8_700_000, "source-y"),
  ];
  assertEqual(detectContradictions(agree).length, 0, "matching values do not contradict");
});

test("corroboration reserves the label for two independent sources", () => {
  const period = "FY2024";
  const entity = "SC000000";

  // Two independent sources agreeing -> I2, corroborated.
  const two = [
    mkFact("ebitda", period, 8_700_000, "source-x"),
    mkFact("ebitda", period, 8_700_000, "source-y"),
  ];
  const s2 = corroborationState(two, entity, "ebitda", period);
  assertEqual(s2.level, "I2", "two independent sources -> I2");
  assertEqual(s2.label, "corroborated", "I2 is labelled corroborated");
  assert(s2.corroborated, "corroborated flag set");
  assertEqual(s2.independentSources.length, 2, "two independent sources counted");

  // A single source -> I1, never corroborated.
  const one = [mkFact("ebitda", period, 8_700_000, "source-x")];
  const s1 = corroborationState(one, entity, "ebitda", period);
  assertEqual(s1.level, "I1", "single source -> I1");
  assert(!s1.corroborated, "single source is not corroborated");
  assertEqual(s1.label, "single-source", "single source labelled single-source");

  // The SAME source cited twice is still one source -> I1, not corroborated.
  const sameTwice = [
    mkFact("ebitda", period, 8_700_000, "source-x"),
    mkFact("ebitda", period, 8_700_000, "source-x"),
  ];
  const sSame = corroborationState(sameTwice, entity, "ebitda", period);
  assertEqual(sSame.level, "I1", "same source twice -> I1");
  assert(!sSame.corroborated, "same source twice is not corroborated");

  // Two independent sources that DISAGREE -> conflicting, corroboration withheld.
  const conflict = [
    mkFact("ebitda", period, 8_700_000, "source-x"),
    mkFact("ebitda", period, 6_000_000, "source-y"),
  ];
  const sConflict = corroborationState(conflict, entity, "ebitda", period);
  assert(!sConflict.corroborated, "conflicting sources are not corroborated");
  assertEqual(sConflict.label, "conflicting", "conflict is surfaced, not corroborated");
});
