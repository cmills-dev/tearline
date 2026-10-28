// lib/engineB/mandate.ts
// Engine B is the origination side of the product: a fund's MANDATE in, a ranked,
// evidence-backed list of fitting company names out. A MandateSpec is the typed brief.
// It never invents a name or a number; it only expresses what the fund is hunting for,
// and screen.ts scores the illustrative universe against it deterministically.

// Sector and region taxonomies. Kept small and shared with the universe so hard filters
// compare like with like. Keys are stable; labels are display-only.
export const SECTORS = {
  software: "Software",
  industrials: "Industrials",
  consumer: "Consumer & retail",
  healthcare: "Healthcare",
  "business-services": "Business services",
} as const;

export type SectorKey = keyof typeof SECTORS;

export const REGIONS = {
  uk: "United Kingdom",
  europe: "Continental Europe",
  "north-america": "North America",
} as const;

export type RegionKey = keyof typeof REGIONS;

// The situation vocabulary. A mandate lists the situations it wants; a universe member
// carries the situations it is tagged with. Overlap is soft-scored, never a hard filter.
export const SITUATION_TAGS = [
  "refinancing wall",
  "underperforming",
  "sponsor-owned",
  "covenant pressure",
  "carve-out",
] as const;

export type SituationTagKey = (typeof SITUATION_TAGS)[number];

// Which figure the size band is expressed in. A mandate can screen on turnover or EBITDA.
export type SizeMetric = "turnover" | "ebitda";

// A band is a min/max pair; either end may be left open with `undefined`.
export interface SizeBand {
  metric: SizeMetric;
  min?: number; // GBP
  max?: number; // GBP
}

export interface LeverageBand {
  min?: number; // net debt / EBITDA, in turns (x)
  max?: number; // in turns (x)
}

export interface MandateSpec {
  id: string;
  name: string;
  description: string;
  sectors: SectorKey[]; // empty => any sector passes the hard filter
  geography: RegionKey[]; // empty => any geography passes the hard filter
  size: SizeBand;
  leverage: LeverageBand;
  situationTags: SituationTagKey[]; // desired situations, soft-weighted
}

// Example mandates, shipped as presets so the screen has something honest to run against.
export const MANDATE_PRESETS: MandateSpec[] = [
  {
    id: "uk-midmarket-refi-wall",
    name: "UK mid-market refinancing wall",
    description:
      "UK companies of mid-market scale with a maturity approaching and gearing high enough to make the refinancing a live question.",
    sectors: [],
    geography: ["uk"],
    size: { metric: "ebitda", min: 5_000_000, max: 30_000_000 },
    leverage: { min: 3.0 },
    situationTags: ["refinancing wall", "covenant pressure"],
  },
  {
    id: "sponsor-software-levered",
    name: "Sponsor-owned software, levered",
    description:
      "Software names under private-equity ownership carrying meaningful gearing, where a sponsor exit or refinancing may open a conversation.",
    sectors: ["software"],
    geography: [],
    size: { metric: "ebitda", min: 3_000_000 },
    leverage: { min: 4.0 },
    situationTags: ["sponsor-owned", "refinancing wall"],
  },
  {
    id: "uk-underperforming-consumer",
    name: "UK underperforming consumer",
    description:
      "UK consumer and retail names of scale that are trading below plan and feeling covenant pressure.",
    sectors: ["consumer"],
    geography: ["uk"],
    size: { metric: "turnover", min: 20_000_000 },
    leverage: { min: 2.5 },
    situationTags: ["underperforming", "covenant pressure"],
  },
];

export function getMandatePreset(id: string): MandateSpec | undefined {
  return MANDATE_PRESETS.find((m) => m.id === id);
}
