// lib/engineB/universe.ts
// The illustrative screening universe. Every name here is SYNTHETIC and belongs to no
// real entity; the whole set is stamped illustrative. Each member carries a compact,
// provenance-bearing fact profile in the same style as the tear-sheet fixtures: sector,
// turnover, EBITDA (with a resolution rung), net debt, leverage and situation tags, each
// pointing at a source stub. Leverage always ties to net debt / EBITDA by construction.
//
// The two existing borrowers (meridian, redacta) are REUSED from their fixtures: their
// figures are pulled from the assembled fact manifest so the numbers match their tear
// sheets exactly. The remaining members are light new synthetic profiles.

import type { FactValueKind, ProvenanceTag, Rung } from "../engine/types";
import { buildManifest } from "../engine/buildManifest";
import { meridian } from "../sources/fixtures/meridian";
import { redacta } from "../sources/fixtures/redacta";
import type { SectorKey, RegionKey, SituationTagKey } from "./mandate";
import { SECTORS, REGIONS } from "./mandate";

const RETRIEVED = "2026-07-28";

// A trimmed provenance stub. Same shape as the tear-sheet Provenance minus the content
// hash, which the tear sheet computes at assemble time and the screen does not need.
export interface UniverseProvenance {
  sourceId: string;
  tag: ProvenanceTag;
  documentName: string;
  locator: string;
  snippet: string;
  retrievedAt: string;
}

// One figure on a universe member. Numbers live here, never in prose. A null value at
// R4 means the figure abstained (e.g. turnover not filed under a filleted exemption).
export interface UniverseFact {
  metric: string;
  label: string;
  kind: FactValueKind;
  unit: string;
  value: number | null;
  rung: Rung;
  provenance: UniverseProvenance | null;
}

export interface SituationTagFact {
  tag: SituationTagKey;
  provenance: UniverseProvenance;
}

// Provenance class of a member. The synthetic demo set is "synthetic"; members projected
// from a tenant's real, entitled relationship graph are "graph". Absent means synthetic, so
// every existing member reads exactly as before.
export type MemberSource = "synthetic" | "graph";

export interface UniverseMember {
  key: string;
  displayName: string;
  redactedName?: boolean;
  sheetKey?: string; // links through to an Engine A tear sheet where one exists
  sector: SectorKey;
  sectorLabel: string;
  geography: RegionKey;
  geographyLabel: string;
  turnover: UniverseFact;
  ebitda: UniverseFact;
  netDebt: UniverseFact;
  leverage: UniverseFact;
  situationTags: SituationTagFact[];
  // true => illustrative synthetic demo name; false => a real, entitled entity projected
  // from the tenant's own graph. The synthetic demo set below is always true.
  synthetic: boolean;
  // Provenance class. Absent on the synthetic demo members (they read as before); set to
  // "graph" on members projected from the real relationship graph so a caller can tell the
  // entitled names apart from the demo set.
  sourceClass?: MemberSource;
}

// ---------------------------------------------------------------------------
// Reuse the two tear-sheet fixtures. Pull their resolved facts from the manifest so the
// figures are identical to the sheet, then overlay clearly-labelled situation tags.
// ---------------------------------------------------------------------------

function overlay(
  sourceId: string,
  snippet: string,
  tag: SituationTagKey
): SituationTagFact {
  return {
    tag,
    provenance: {
      sourceId,
      tag: "Web",
      documentName: "Situation overlay (illustrative analyst tag)",
      locator: "Origination note",
      snippet,
      retrievedAt: RETRIEVED,
    },
  };
}

function fromFixture(
  fixture: typeof meridian,
  opts: {
    sector: SectorKey;
    geography: RegionKey;
    situationTags: SituationTagFact[];
  }
): UniverseMember {
  const m = buildManifest(fixture);
  const pick = (metric: string, label: string): UniverseFact => {
    const f = m.facts[`${metric}.FY2024`];
    return {
      metric,
      label,
      kind: f.kind,
      unit: f.unit,
      value: f.value === null ? null : typeof f.value === "number" ? f.value : null,
      rung: f.rung,
      provenance: f.provenance
        ? {
            sourceId: f.provenance.sourceId,
            tag: f.provenance.tag,
            documentName: f.provenance.documentName,
            locator: f.provenance.locator,
            snippet: f.provenance.snippet,
            retrievedAt: f.provenance.retrievedAt,
          }
        : null,
    };
  };
  return {
    key: fixture.key,
    displayName: fixture.displayName,
    redactedName: fixture.redactedName,
    sheetKey: fixture.key,
    sector: opts.sector,
    sectorLabel: SECTORS[opts.sector],
    geography: opts.geography,
    geographyLabel: REGIONS[opts.geography],
    turnover: pick("turnover", "Turnover"),
    ebitda: pick("ebitda", "EBITDA"),
    netDebt: pick("netDebt", "Net debt"),
    leverage: pick("leverage", "Leverage (net debt / EBITDA)"),
    situationTags: opts.situationTags,
    synthetic: true,
  };
}

// ---------------------------------------------------------------------------
// New synthetic members. Compact builder: leverage is COMPUTED from net debt / EBITDA so
// it can never drift from its inputs.
// ---------------------------------------------------------------------------

interface NewMemberSpec {
  key: string;
  displayName: string;
  sector: SectorKey;
  geography: RegionKey;
  turnover: number; // GBP
  ebitda: number; // GBP
  netDebt: number; // GBP
  situationTags: SituationTagKey[];
  basis: string; // one-line source snippet for the profile
}

function synth(s: NewMemberSpec): UniverseMember {
  const src = `${s.key}-profile`;
  const leverage = Math.round((s.netDebt / s.ebitda) * 100) / 100;
  const prov = (locator: string, snippet: string): UniverseProvenance => ({
    sourceId: src,
    tag: "Acc",
    documentName: "Synthetic profile (illustrative, Companies House shape)",
    locator,
    snippet,
    retrievedAt: RETRIEVED,
  });
  const cur = (
    metric: string,
    label: string,
    value: number,
    rung: Rung,
    line: string
  ): UniverseFact => ({
    metric,
    label,
    kind: "currency",
    unit: "GBP",
    value,
    rung,
    provenance: prov(line, `${s.basis}. ${line}`),
  });
  return {
    key: s.key,
    displayName: s.displayName,
    sector: s.sector,
    sectorLabel: SECTORS[s.sector],
    geography: s.geography,
    geographyLabel: REGIONS[s.geography],
    turnover: cur("turnover", "Turnover", s.turnover, "R1", "Turnover line, profit and loss"),
    ebitda: cur("ebitda", "EBITDA", s.ebitda, "R2", "EBITDA, synthesised from EBIT plus depreciation and amortisation"),
    netDebt: cur("netDebt", "Net debt", s.netDebt, "R2", "Net debt, synthesised from borrowings less cash"),
    leverage: {
      metric: "leverage",
      label: "Leverage (net debt / EBITDA)",
      kind: "ratio",
      unit: "x",
      value: leverage,
      rung: "R2",
      provenance: prov(
        "Leverage, synthesised from net debt / EBITDA",
        `${s.basis}. Leverage = net debt / EBITDA`
      ),
    },
    situationTags: s.situationTags.map((t) =>
      overlay(src, `Tagged ${t} from the origination overlay`, t)
    ),
    synthetic: true,
  };
}

// The twelve new synthetic members. Spread across sectors, sizes, gearing and situations
// so the presets in mandate.ts each pick up a defensible, non-trivial shortlist.
const NEW_MEMBERS: UniverseMember[] = [
  synth({ key: "helios", displayName: "HELIOS SOFTWARE (illustrative)", sector: "software", geography: "uk", turnover: 22_000_000, ebitda: 6_500_000, netDebt: 32_500_000, situationTags: ["sponsor-owned", "refinancing wall"], basis: "Illustrative synthetic software profile" }),
  synth({ key: "calder", displayName: "CALDER SYSTEMS (illustrative)", sector: "software", geography: "europe", turnover: 40_000_000, ebitda: 11_000_000, netDebt: 55_000_000, situationTags: ["sponsor-owned", "covenant pressure"], basis: "Illustrative synthetic DACH software profile" }),
  synth({ key: "orinoco", displayName: "ORINOCO RETAIL (illustrative)", sector: "consumer", geography: "uk", turnover: 85_000_000, ebitda: 5_000_000, netDebt: 15_000_000, situationTags: ["underperforming", "refinancing wall"], basis: "Illustrative synthetic retail profile" }),
  synth({ key: "pennine", displayName: "PENNINE MANUFACTURING (illustrative)", sector: "industrials", geography: "uk", turnover: 60_000_000, ebitda: 9_000_000, netDebt: 27_000_000, situationTags: ["refinancing wall", "covenant pressure"], basis: "Illustrative synthetic industrials profile" }),
  synth({ key: "ashworth", displayName: "ASHWORTH HEALTHCARE (illustrative)", sector: "healthcare", geography: "uk", turnover: 35_000_000, ebitda: 7_000_000, netDebt: 21_000_000, situationTags: ["sponsor-owned"], basis: "Illustrative synthetic healthcare profile" }),
  synth({ key: "vector", displayName: "VECTOR BUSINESS SERVICES (illustrative)", sector: "business-services", geography: "uk", turnover: 28_000_000, ebitda: 5_500_000, netDebt: 11_000_000, situationTags: ["carve-out"], basis: "Illustrative synthetic business-services profile" }),
  synth({ key: "tamesis", displayName: "TAMESIS LOGISTICS (illustrative)", sector: "industrials", geography: "uk", turnover: 120_000_000, ebitda: 12_000_000, netDebt: 48_000_000, situationTags: ["refinancing wall", "sponsor-owned"], basis: "Illustrative synthetic logistics profile" }),
  synth({ key: "norwood", displayName: "NORWOOD CONSUMER BRANDS (illustrative)", sector: "consumer", geography: "uk", turnover: 45_000_000, ebitda: 6_000_000, netDebt: 24_000_000, situationTags: ["underperforming", "covenant pressure"], basis: "Illustrative synthetic consumer-brands profile" }),
  synth({ key: "quantum", displayName: "QUANTUM ANALYTICS (illustrative)", sector: "software", geography: "north-america", turnover: 30_000_000, ebitda: 8_000_000, netDebt: 40_000_000, situationTags: ["sponsor-owned"], basis: "Illustrative synthetic analytics profile" }),
  synth({ key: "blackford", displayName: "BLACKFORD CHEMICALS (illustrative)", sector: "industrials", geography: "uk", turnover: 200_000_000, ebitda: 25_000_000, netDebt: 50_000_000, situationTags: ["carve-out"], basis: "Illustrative synthetic chemicals profile" }),
  synth({ key: "mercia", displayName: "MERCIA CARE HOMES (illustrative)", sector: "healthcare", geography: "uk", turnover: 18_000_000, ebitda: 3_000_000, netDebt: 12_000_000, situationTags: ["covenant pressure", "underperforming"], basis: "Illustrative synthetic care-home profile" }),
  synth({ key: "lowell", displayName: "LOWELL SOFTWARE (illustrative)", sector: "software", geography: "uk", turnover: 12_000_000, ebitda: 2_500_000, netDebt: 5_000_000, situationTags: ["sponsor-owned"], basis: "Illustrative synthetic software profile" }),
];

// The two reused tear-sheet borrowers, with clearly-labelled situation overlays.
const MERIDIAN_MEMBER = fromFixture(meridian, {
  sector: "industrials",
  geography: "uk",
  situationTags: [
    overlay("meridian-charges", "Senior term loan drawn 2022, maturity approaching", "refinancing wall"),
  ],
});

const REDACTA_MEMBER = fromFixture(redacta, {
  sector: "consumer",
  geography: "uk",
  situationTags: [
    overlay("redacta-aa-2024", "Thin filleted disclosure and asset-finance gearing", "covenant pressure"),
    overlay("redacta-aa-2024", "Operating profit modest against secured borrowings", "underperforming"),
  ],
});

export const UNIVERSE: UniverseMember[] = [
  MERIDIAN_MEMBER,
  REDACTA_MEMBER,
  ...NEW_MEMBERS,
];

// A single stamp any UI can render so the synthetic nature is never in doubt.
export const UNIVERSE_STAMP =
  "Illustrative synthetic data. No name in this universe is a real entity.";

// Which population the screen should run against. Default is "synthetic", so every existing
// caller (and every existing test) keeps the illustrative demo universe unchanged.
export type UniverseSource = "synthetic" | "graph" | "both";

export interface ListUniverseOptions {
  source?: UniverseSource; // default "synthetic"
  // Entitled members projected from the tenant's real graph, produced by
  // universeFromGraph(...). Required for "graph" or "both"; ignored for "synthetic".
  graphMembers?: UniverseMember[];
}

// Default (no argument) returns the synthetic demo universe, the same reference as before.
// "graph" returns only the supplied entitled members; "both" appends them after the demo
// set. The synthetic members are never mutated and their order is preserved.
export function listUniverse(opts?: ListUniverseOptions): UniverseMember[] {
  const source = opts?.source ?? "synthetic";
  if (source === "synthetic") return UNIVERSE;
  const graphMembers = opts?.graphMembers ?? [];
  if (source === "graph") return graphMembers;
  return [...UNIVERSE, ...graphMembers];
}

export function getUniverseMember(key: string): UniverseMember | undefined {
  return UNIVERSE.find((m) => m.key === key);
}
