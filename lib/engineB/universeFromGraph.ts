// lib/engineB/universeFromGraph.ts
// Projects a tenant's REAL graph company nodes into screenable UniverseMembers, so Engine B
// can be run against entitled names, not only the synthetic demo set. It reuses the exact
// UniverseMember / UniverseFact shape and keeps the tear-sheet honesty discipline: every
// derived figure is copied straight from a CITED manifest fact (provenance carried through),
// a metric with no cited value abstains (R4, value null, provenance null) rather than being
// guessed, and a node with NO cited fact at all is omitted, never surfaced on invented data.
//
// This module is a pure projection. It does not read the graph or manifest stores itself
// (those are owned elsewhere and are tenant-scoped and async); the caller loads each company
// node together with its assembled FactManifest and its classification, and passes them in.
// Wire-up, once you have the members:
//
//   const members = universeFromGraph(inputs);
//   const universe = listUniverse({ source: "both", graphMembers: members });
//   const out = screen(mandate, universe);

import type { Fact, FactManifest, FactValueKind, Rung } from "../engine/types";
import type { GraphNode } from "../graph/model";
import type { SectorKey, RegionKey } from "./mandate";
import { SECTORS, REGIONS } from "./mandate";
import type {
  SituationTagFact,
  UniverseFact,
  UniverseMember,
  UniverseProvenance,
} from "./universe";

// One company node ready to project. The caller supplies the node, its assembled manifest
// (or null if none exists yet), and the classification the screen filters on. Sector and
// geography are the caller's concern (resolution / classification lives elsewhere); this
// module only governs the figures, which must trace to a cited fact.
export interface GraphCompanyInput {
  node: GraphNode; // must be kind === "company"
  manifest: FactManifest | null; // the node's cited facts, if a tear sheet has been built
  sector: SectorKey;
  geography: RegionKey;
  // Optional, evidence-backed situation overlays. Reuse the SituationTagFact shape exactly,
  // so each tag already carries its own provenance. Default is none; nothing is invented.
  situationTags?: SituationTagFact[];
  // Optional link through to a stored tear sheet, mirroring UniverseMember.sheetKey.
  sheetKey?: string;
}

// The four metrics a member is screened on, with the unit/kind an absent figure abstains to.
const METRIC_SHAPE: Record<
  string,
  { label: string; kind: FactValueKind; unit: string }
> = {
  turnover: { label: "Turnover", kind: "currency", unit: "GBP" },
  ebitda: { label: "EBITDA", kind: "currency", unit: "GBP" },
  netDebt: { label: "Net debt", kind: "currency", unit: "GBP" },
  leverage: { label: "Leverage (net debt / EBITDA)", kind: "ratio", unit: "x" },
};

// A manifest fact is CITED when it carries provenance and a real number. R4 abstentions
// (provenance null, value null) and text values are not cited and never become a figure.
function isCited(fact: Fact | undefined): fact is Fact & { value: number } {
  return (
    !!fact &&
    fact.provenance !== null &&
    fact.value !== null &&
    typeof fact.value === "number"
  );
}

// The latest period present across the screened metrics. Fact ids are "<metric>.<period>"
// with period keys like "FY2024", which sort correctly by string, so the reverse-sorted
// head is the most recent. Deterministic; returns null when the manifest has none of them.
function primaryPeriod(manifest: FactManifest): string | null {
  const periods = new Set<string>();
  for (const f of Object.values(manifest.facts)) {
    if (f.metric in METRIC_SHAPE) periods.add(f.period);
  }
  if (periods.size === 0) return null;
  return [...periods].sort().reverse()[0];
}

// Strip the tear-sheet Provenance to the screen's UniverseProvenance (drops the content
// hash, which the screen does not need). Copies the citation verbatim, inventing nothing.
function carryProvenance(fact: Fact & { value: number }): UniverseProvenance {
  const p = fact.provenance!;
  return {
    sourceId: p.sourceId,
    tag: p.tag,
    documentName: p.documentName,
    locator: p.locator,
    snippet: p.snippet,
    retrievedAt: p.retrievedAt,
  };
}

// One screened figure. A cited fact is copied through with its rung and provenance; anything
// else abstains honestly at R4 with a null value and null provenance, so a missing filing is
// visible as an abstention rather than filled with a guess.
function toUniverseFact(metric: string, fact: Fact | undefined): UniverseFact {
  const shape = METRIC_SHAPE[metric];
  if (isCited(fact)) {
    return {
      metric,
      label: shape.label,
      kind: fact.kind,
      unit: fact.unit,
      value: fact.value,
      rung: fact.rung,
      provenance: carryProvenance(fact),
    };
  }
  // An uncited figure is an abstention, whatever rung the source claimed.
  const rung: Rung = "R4";
  return {
    metric,
    label: shape.label,
    kind: fact?.kind ?? shape.kind,
    unit: fact?.unit ?? shape.unit,
    value: null,
    rung,
    provenance: null,
  };
}

// Project a single company node. Returns a screenable member when at least one figure is
// cited, or null (omit) when the node has no manifest or no cited figure at all. Never
// fabricates: uncited metrics are carried as abstentions, not invented.
export function projectGraphCompany(input: GraphCompanyInput): UniverseMember | null {
  const { node, manifest } = input;
  if (node.kind !== "company") return null;
  if (!manifest) return null;

  const period = primaryPeriod(manifest);
  if (period === null) return null;

  const factFor = (metric: string): Fact | undefined =>
    manifest.facts[`${metric}.${period}`];

  const turnover = toUniverseFact("turnover", factFor("turnover"));
  const ebitda = toUniverseFact("ebitda", factFor("ebitda"));
  const netDebt = toUniverseFact("netDebt", factFor("netDebt"));
  const leverage = toUniverseFact("leverage", factFor("leverage"));

  // Honesty gate: with not one cited figure there is nothing entitled to screen on, so the
  // node is omitted rather than surfaced on an empty (or guessed) profile.
  const anyCited = [turnover, ebitda, netDebt, leverage].some(
    (f) => f.provenance !== null,
  );
  if (!anyCited) return null;

  return {
    key: node.id,
    displayName: node.displayName,
    sheetKey: input.sheetKey,
    sector: input.sector,
    sectorLabel: SECTORS[input.sector],
    geography: input.geography,
    geographyLabel: REGIONS[input.geography],
    turnover,
    ebitda,
    netDebt,
    leverage,
    situationTags: input.situationTags ?? [],
    synthetic: false, // a real, entitled entity, not a demo name
    sourceClass: "graph",
  };
}

// Project many. Nodes with no cited fact drop out (abstain) rather than being guessed, so the
// returned set is exactly the entitled names the screen can defensibly rank.
export function universeFromGraph(inputs: GraphCompanyInput[]): UniverseMember[] {
  const out: UniverseMember[] = [];
  for (const input of inputs) {
    const member = projectGraphCompany(input);
    if (member) out.push(member);
  }
  return out;
}

// A stamp a UI can render over the entitled population, distinct from UNIVERSE_STAMP. These
// names are real and drawn from the tenant's own entitled data, so they are labelled as such
// and never redistributed beyond the tenant.
export const GRAPH_UNIVERSE_STAMP =
  "Entitled data. These names are real entities projected from your own relationship graph, each figure traced to a cited filing.";
