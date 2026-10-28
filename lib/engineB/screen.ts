// lib/engineB/screen.ts
// The deterministic screen. A MandateSpec in, a ranked, evidence-backed list of universe
// members out. No model is involved and no narrative is invented: every reason is a typed
// statement built from a member's own facts and the mandate's own bands. Hard filters
// (sector, geography) exclude with a logged reason, honestly, the way the ladder abstains
// at R4. Soft fit (size in band, leverage in band, situation overlap) is scored on a fixed
// formula, so the same mandate always produces the same ranking.

import { formatValue } from "../format/format";
import { assertClean } from "../engine/prosegate";
import type { MandateSpec, SizeBand, LeverageBand } from "./mandate";
import { SECTORS, REGIONS } from "./mandate";
import type { UniverseFact, UniverseMember } from "./universe";
import { listUniverse } from "./universe";

// Fixed soft-fit weights. They sum to 1 so the raw score sits in 0..1 before scaling.
const WEIGHTS = { size: 0.35, leverage: 0.35, situation: 0.3 } as const;

export type ReasonKind =
  | "sector"
  | "geography"
  | "size"
  | "leverage"
  | "situation"
  | "abstain";

export type Polarity = "supports" | "neutral" | "against";

// A typed reason. `text` is prose built only from fact and mandate figures; it is run
// through ProseGate before it ships. `factMetric` points back at the member fact it rests
// on, so a reader can trace every claim to a figure.
export interface EvidenceReason {
  kind: ReasonKind;
  polarity: Polarity;
  text: string;
  factMetric?: string;
}

export interface Exclusion {
  failedFilter: "sector" | "geography";
  reason: string;
}

export interface ScreenResult {
  member: UniverseMember;
  included: boolean;
  score: number; // 0..100 integer for included members, 0 for excluded
  reasons: EvidenceReason[];
  rationale?: string; // one-line, ProseGate-clean, present on included members
  exclusion?: Exclusion;
}

export interface ScreenOutput {
  mandate: MandateSpec;
  ranked: ScreenResult[]; // included, best first
  excluded: ScreenResult[]; // failed a hard filter, with logged reason
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Band scoring. Returns a 0..1 fit plus a status word used to phrase the reason.
// ---------------------------------------------------------------------------

type BandStatus = "in" | "below" | "above" | "abstain";

function scoreBand(
  value: number | null,
  min: number | undefined,
  max: number | undefined
): { score: number; status: BandStatus } {
  if (value === null) return { score: 0, status: "abstain" };
  if (min !== undefined && value < min) {
    // proximity to the floor, softened so a near miss still earns something
    const proximity = min === 0 ? 0 : Math.max(0, value / min);
    return { score: Math.min(1, proximity) * 0.6, status: "below" };
  }
  if (max !== undefined && value > max) {
    const proximity = value === 0 ? 0 : Math.max(0, max / value);
    return { score: Math.min(1, proximity) * 0.6, status: "above" };
  }
  return { score: 1, status: "in" };
}

// ---------------------------------------------------------------------------
// Reason phrasing. Numbers come only from facts and the mandate; nothing is originated.
// ---------------------------------------------------------------------------

function fig(fact: UniverseFact): string {
  return formatValue(fact.value, fact.kind, fact.unit);
}

function money(value: number): string {
  return formatValue(value, "currency", "GBP");
}

function turns(value: number): string {
  return formatValue(value, "ratio", "x");
}

// Verdict phrasing for a band. Reads naturally whether the band is a range, a floor only
// or a ceiling only. `fmt` renders each bound in the right unit.
function verdictFor(
  status: Exclude<BandStatus, "abstain">,
  min: number | undefined,
  max: number | undefined,
  fmt: (n: number) => string
): string {
  const hasMin = min !== undefined;
  const hasMax = max !== undefined;
  if (status === "in") {
    if (hasMin && hasMax) return `sits inside the ${fmt(min!)} to ${fmt(max!)} band`;
    if (hasMin) return `clears the ${fmt(min!)} floor`;
    if (hasMax) return `sits under the ${fmt(max!)} ceiling`;
    return "sits within an open band";
  }
  if (status === "below") return `sits below the ${fmt(min!)} floor`;
  return `sits above the ${fmt(max!)} ceiling`;
}

function bandNounSize(size: SizeBand): string {
  if (size.min !== undefined && size.max !== undefined)
    return `${money(size.min)} to ${money(size.max)} band`;
  if (size.min !== undefined) return `${money(size.min)} floor`;
  if (size.max !== undefined) return `${money(size.max)} ceiling`;
  return "open band";
}

function bandNounLev(lev: LeverageBand): string {
  if (lev.min !== undefined && lev.max !== undefined)
    return `${turns(lev.min)} to ${turns(lev.max)} band`;
  if (lev.min !== undefined) return `${turns(lev.min)} floor`;
  if (lev.max !== undefined) return `${turns(lev.max)} ceiling`;
  return "open band";
}

function sizeReason(
  member: UniverseMember,
  size: SizeBand,
  status: BandStatus
): EvidenceReason {
  const fact = size.metric === "turnover" ? member.turnover : member.ebitda;
  const label = size.metric === "turnover" ? "Turnover" : "EBITDA";
  if (status === "abstain") {
    return {
      kind: "abstain",
      polarity: "neutral",
      factMetric: fact.metric,
      text: assertClean(
        `${label} is not filed, so fit against the ${bandNounSize(size)} is not assessable and abstains.`,
        "screen.size.abstain"
      ),
    };
  }
  return {
    kind: "size",
    polarity: status === "in" ? "supports" : "against",
    factMetric: fact.metric,
    text: assertClean(
      `${label} of ${fig(fact)} ${verdictFor(status, size.min, size.max, money)}.`,
      "screen.size"
    ),
  };
}

function leverageReason(
  member: UniverseMember,
  lev: LeverageBand,
  status: BandStatus
): EvidenceReason {
  const fact = member.leverage;
  if (status === "abstain") {
    return {
      kind: "abstain",
      polarity: "neutral",
      factMetric: fact.metric,
      text: assertClean(
        `Leverage cannot be built, so fit against the ${bandNounLev(lev)} abstains.`,
        "screen.leverage.abstain"
      ),
    };
  }
  return {
    kind: "leverage",
    polarity: status === "below" ? "against" : "supports",
    factMetric: fact.metric,
    text: assertClean(
      `Leverage of ${fig(fact)} ${verdictFor(status, lev.min, lev.max, turns)}.`,
      "screen.leverage"
    ),
  };
}

// ---------------------------------------------------------------------------
// Scoring one member against one mandate.
// ---------------------------------------------------------------------------

function screenMember(member: UniverseMember, mandate: MandateSpec): ScreenResult {
  const reasons: EvidenceReason[] = [];

  // Hard filter: sector.
  if (mandate.sectors.length > 0 && !mandate.sectors.includes(member.sector)) {
    return {
      member,
      included: false,
      score: 0,
      reasons: [],
      exclusion: {
        failedFilter: "sector",
        reason: `Sector ${SECTORS[member.sector]} is outside the mandate set (${mandate.sectors
          .map((s) => SECTORS[s])
          .join(", ")}).`,
      },
    };
  }

  // Hard filter: geography.
  if (mandate.geography.length > 0 && !mandate.geography.includes(member.geography)) {
    return {
      member,
      included: false,
      score: 0,
      reasons: [],
      exclusion: {
        failedFilter: "geography",
        reason: `Geography ${REGIONS[member.geography]} is outside the mandate set (${mandate.geography
          .map((g) => REGIONS[g])
          .join(", ")}).`,
      },
    };
  }

  // Passed the hard filters: record them as supporting evidence.
  reasons.push({
    kind: "sector",
    polarity: "supports",
    text: assertClean(
      `Sector ${SECTORS[member.sector]} matches the mandate.`,
      "screen.sector"
    ),
  });
  reasons.push({
    kind: "geography",
    polarity: "supports",
    text: assertClean(
      `Geography ${REGIONS[member.geography]} matches the mandate.`,
      "screen.geography"
    ),
  });

  // Soft fit: size.
  const sizeFact = mandate.size.metric === "turnover" ? member.turnover : member.ebitda;
  const sizeBand = scoreBand(sizeFact.value, mandate.size.min, mandate.size.max);
  reasons.push(sizeReason(member, mandate.size, sizeBand.status));

  // Soft fit: leverage.
  const levBand = scoreBand(member.leverage.value, mandate.leverage.min, mandate.leverage.max);
  reasons.push(leverageReason(member, mandate.leverage, levBand.status));

  // Soft fit: situation overlap.
  const memberTags = new Set(member.situationTags.map((t) => t.tag));
  const wanted = mandate.situationTags;
  const matched = wanted.filter((t) => memberTags.has(t));
  const situationScore = wanted.length === 0 ? 0 : matched.length / wanted.length;
  for (const t of matched) {
    reasons.push({
      kind: "situation",
      polarity: "supports",
      text: assertClean(`Tagged: ${t}.`, "screen.situation"),
    });
  }

  const raw =
    WEIGHTS.size * sizeBand.score +
    WEIGHTS.leverage * levBand.score +
    WEIGHTS.situation * situationScore;
  const score = Math.round(raw * 100);

  const rationale = buildRationale(member, mandate, sizeBand.status, levBand.status, matched);

  return { member, included: true, score, reasons, rationale };
}

// A single ProseGate-clean line summarising why the name fits. Built only from the
// member's facts and the mandate's own figures; passed through the gate before returning.
function buildRationale(
  member: UniverseMember,
  mandate: MandateSpec,
  sizeStatus: BandStatus,
  levStatus: BandStatus,
  matched: string[]
): string {
  const name = displayNameForProse(member.displayName);
  const sizeFact = mandate.size.metric === "turnover" ? member.turnover : member.ebitda;
  const sizeLabel = mandate.size.metric === "turnover" ? "turnover" : "EBITDA";

  const parts: string[] = [];
  if (sizeStatus === "abstain") {
    parts.push(`${sizeLabel} is not filed`);
  } else {
    const where =
      sizeStatus === "in" ? "inside the size band" : sizeStatus === "below" ? "below the size band" : "above the size band";
    parts.push(`${sizeLabel} of ${fig(sizeFact)} ${where}`);
  }
  if (levStatus === "abstain") {
    parts.push("leverage abstains");
  } else {
    const where =
      levStatus === "in"
        ? "within the leverage band"
        : levStatus === "below"
          ? "below the leverage floor"
          : "above the leverage floor";
    parts.push(`leverage of ${fig(member.leverage)} ${where}`);
  }
  if (matched.length > 0) {
    parts.push(`tagged ${matched.join(" and ")}`);
  }

  const sentence = `${name} shows ${joinClauses(parts)}.`;
  return assertClean(sentence, `screen.rationale.${member.key}`);
}

// Strip the "(illustrative)" and any redaction marks for a cleaner prose subject, and
// title-case the codename so the sentence reads as a document, not a shout.
function displayNameForProse(displayName: string): string {
  const base = displayName.replace(/\(illustrative\)/i, "").replace(/[▮]+/g, "a redacted name").trim();
  return base
    .split(/\s+/)
    .map((word) =>
      /^[A-Z0-9&]+$/.test(word) && word.length > 1
        ? word.charAt(0) + word.slice(1).toLowerCase()
        : word
    )
    .join(" ");
}

function joinClauses(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

// ---------------------------------------------------------------------------
// The public screen. Deterministic: sort by score descending, then by key ascending, so
// ties always resolve the same way.
// ---------------------------------------------------------------------------

export function screen(
  mandate: MandateSpec,
  universe: UniverseMember[] = listUniverse()
): ScreenOutput {
  const results = universe.map((m) => screenMember(m, mandate));
  const ranked = results
    .filter((r) => r.included)
    .sort((a, b) => (b.score - a.score) || a.member.key.localeCompare(b.member.key));
  const excluded = results
    .filter((r) => !r.included)
    .sort((a, b) => a.member.key.localeCompare(b.member.key));
  return {
    mandate,
    ranked,
    excluded,
    generatedAt: RETRIEVED,
  };
}

const RETRIEVED = "2026-07-28";
