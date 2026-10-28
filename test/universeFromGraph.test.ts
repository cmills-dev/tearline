// test/universeFromGraph.test.ts
// Engine B, graph-fed universe: a real company node WITH cited facts becomes a screenable
// member whose reasons trace to those facts; a node WITHOUT cited facts is omitted (no
// invented figures); and the default synthetic universe is byte-for-byte unchanged.

import { buildManifest } from "../lib/engine/buildManifest";
import { meridian } from "../lib/sources/fixtures/meridian";
import type { FactManifest } from "../lib/engine/types";
import type { GraphNode } from "../lib/graph/model";
import type { MandateSpec } from "../lib/engineB/mandate";
import { listUniverse } from "../lib/engineB/universe";
import {
  projectGraphCompany,
  universeFromGraph,
} from "../lib/engineB/universeFromGraph";
import { screen } from "../lib/engineB/screen";
import { suite, test, assert, assertEqual } from "./harness";

// A resolved company node, the spine a projection sits on.
function companyNode(id: string, name: string): GraphNode {
  return {
    id,
    tenantId: "tenant-1",
    kind: "company",
    displayName: name,
    resolutionConfidence: 0.92,
    resolutionStatus: "resolved",
  };
}

// A manifest whose only screened metric abstains: turnover filed as R4, nothing cited. The
// honest "no figure to stand on" case.
function abstainedManifest(): FactManifest {
  return {
    entity: {
      companyName: "SPARSE HOLDINGS LIMITED",
      companyNumber: "00000002",
      jurisdiction: "england-wales",
      status: "active",
      incorporatedOn: "2001-01-01",
      sicCodes: [],
      registeredOffice: "",
      accountsType: "filleted",
      latestPeriodEnd: "2024-12-31",
      synthetic: false,
    },
    facts: {
      "turnover.FY2024": {
        id: "turnover.FY2024",
        metric: "turnover",
        label: "Turnover",
        period: "FY2024",
        kind: "currency",
        value: null,
        unit: "GBP",
        rung: "R4",
        provenance: null,
        verification: { status: "NOT_APPLICABLE", checks: [] },
      },
    },
    sources: {},
    generatedAt: "2026-07-28",
  };
}

// A mandate with open bands so a UK industrials name is screened in on figures alone.
const openIndustrials: MandateSpec = {
  id: "test-open-industrials",
  name: "Open UK industrials",
  description: "UK industrials, open bands, for the graph-projection test.",
  sectors: ["industrials"],
  geography: ["uk"],
  size: { metric: "ebitda" },
  leverage: {},
  situationTags: [],
};

suite("Engine B / universeFromGraph");

// Snapshot the default universe up front so we can prove it never moves.
const SYNTHETIC_SNAPSHOT = JSON.stringify(listUniverse());

const realManifest = buildManifest(meridian);
const realInput = {
  node: companyNode("real-co", "REAL CO LIMITED"),
  manifest: realManifest,
  sector: "industrials" as const,
  geography: "uk" as const,
};

test("a company node with cited facts becomes a screenable, entitled member", () => {
  const member = projectGraphCompany(realInput);
  assert(member !== null, "member is projected");
  assertEqual(member!.key, "real-co", "keyed by the node id");
  assertEqual(member!.synthetic, false, "marked real, not synthetic");
  assertEqual(member!.sourceClass, "graph", "provenance class is graph");
});

test("every derived figure carries provenance copied from its cited fact", () => {
  const member = projectGraphCompany(realInput)!;
  assert(member.ebitda.provenance !== null, "EBITDA is cited");
  // The figure and its citation match the manifest fact exactly, nothing re-originated.
  const src = realManifest.facts["ebitda.FY2024"];
  assertEqual(member.ebitda.value, src.value as number, "EBITDA value matches the manifest");
  assertEqual(
    member.ebitda.provenance!.sourceId,
    src.provenance!.sourceId,
    "EBITDA provenance traces to the manifest source",
  );
});

test("the screen ranks the entitled member and its reasons trace to the cited facts", () => {
  const member = projectGraphCompany(realInput)!;
  const universe = listUniverse({ source: "graph", graphMembers: [member] });
  const out = screen(openIndustrials, universe);
  assertEqual(out.ranked.length, 1, "the one entitled member is screened in");
  assertEqual(out.ranked[0].member.key, "real-co", "it is our node");
  const sizeReason = out.ranked[0].reasons.find((r) => r.kind === "size")!;
  assertEqual(sizeReason.factMetric, "ebitda", "the size reason points at the EBITDA fact");
});

test("a node with no manifest is omitted, never guessed", () => {
  const member = projectGraphCompany({ ...realInput, manifest: null });
  assertEqual(member, null, "no manifest => omitted");
});

test("a node whose facts all abstain is omitted, with no invented figures", () => {
  const member = projectGraphCompany({
    node: companyNode("sparse-co", "SPARSE HOLDINGS LIMITED"),
    manifest: abstainedManifest(),
    sector: "industrials",
    geography: "uk",
  });
  assertEqual(member, null, "no cited fact => omitted");
});

test("universeFromGraph keeps only the entitled names that have a cited figure", () => {
  const members = universeFromGraph([
    realInput,
    { ...realInput, node: companyNode("no-sheet", "NO SHEET LIMITED"), manifest: null },
    {
      node: companyNode("sparse-co", "SPARSE HOLDINGS LIMITED"),
      manifest: abstainedManifest(),
      sector: "industrials",
      geography: "uk",
    },
  ]);
  assertEqual(members.length, 1, "one of three projects");
  assertEqual(members[0].key, "real-co", "the cited one survives");
});

test("synthetic-only mode is byte-for-byte unchanged", () => {
  // Default and explicit synthetic both return the untouched demo set.
  assertEqual(JSON.stringify(listUniverse()), SYNTHETIC_SNAPSHOT, "default universe unchanged");
  assertEqual(
    JSON.stringify(listUniverse({ source: "synthetic" })),
    SYNTHETIC_SNAPSHOT,
    "explicit synthetic unchanged",
  );
  assert(listUniverse().every((m) => m.synthetic === true), "demo set stays synthetic");
});

test("both mode appends the entitled members without mutating the demo set", () => {
  const member = projectGraphCompany(realInput)!;
  const base = listUniverse();
  const both = listUniverse({ source: "both", graphMembers: [member] });
  assertEqual(both.length, base.length + 1, "graph member appended");
  assertEqual(both[both.length - 1].key, "real-co", "appended after the demo set");
  // The default is still the untouched snapshot after a "both" call.
  assertEqual(JSON.stringify(listUniverse()), SYNTHETIC_SNAPSHOT, "default still unchanged");
});
