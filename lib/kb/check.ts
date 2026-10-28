// lib/kb/check.ts
// The checking engine. This ENRICHES verification beyond the balance-sheet identity that
// lib/engine/verify.ts already runs: more cross-field identities where the facts allow, plus
// two things the plan treats as core doctrine and which must never be hidden:
//   1. contradiction detection  - two facts for the same metric+period that disagree
//   2. an independence ladder    - the label "corroborated" is reserved for genuinely
//      independent agreement (two DIFFERENT sources), never single-source
//
// Everything here is pure and deterministic. It reads facts and returns typed results; it
// does not mutate the manifest or the graph.

import type { Fact } from "../engine/types";

// ---------------------------------------------------------------------------
// Numeric helpers
// ---------------------------------------------------------------------------

const CURRENCY_TOL = 1; // whole-GBP fixtures round to the pound
const RATIO_TOL = 0.02; // ratios are stored to 2dp, so allow a small rounding band

function num(facts: Record<string, Fact>, metric: string, period: string): number | null {
  const f = facts[`${metric}.${period}`];
  return f && typeof f.value === "number" ? f.value : null;
}

function gbp(n: number): string {
  return n.toLocaleString("en-GB");
}

// ---------------------------------------------------------------------------
// 1) Structural identities
// ---------------------------------------------------------------------------
// Each check runs only when its inputs are present, and reports the arithmetic in numbers.
// These sit ALONGSIDE the balance-sheet and trading-account checks in lib/engine/verify.ts;
// they are additive, not a replacement.

export interface CheckResult {
  id: string;
  label: string;
  identity: string; // the identity tested, in words
  passed: boolean;
  detail: string; // the arithmetic actually performed, in numbers
}

// net debt = total borrowings - cash. Reconciles a reported/synthesised net-debt line to its
// components.
function netDebtCheck(facts: Record<string, Fact>, period: string): CheckResult | null {
  const b = num(facts, "borrowings", period);
  const c = num(facts, "cash", period);
  const nd = num(facts, "netDebt", period);
  if (b === null || c === null || nd === null) return null;
  const expected = b - c;
  const passed = Math.abs(nd - expected) <= CURRENCY_TOL;
  return {
    id: `net-debt.${period}`,
    label: "Net debt reconciliation",
    identity: "net debt = total borrowings - cash",
    passed,
    detail: `${gbp(b)} - ${gbp(c)} = ${gbp(expected)} vs reported ${gbp(nd)}`,
  };
}

// EBITDA = operating profit (EBIT) + depreciation & amortisation.
function ebitdaCheck(facts: Record<string, Fact>, period: string): CheckResult | null {
  const ebit = num(facts, "operatingProfit", period);
  const da = num(facts, "depreciationAmortisation", period);
  const ebitda = num(facts, "ebitda", period);
  if (ebit === null || da === null || ebitda === null) return null;
  const expected = ebit + da;
  const passed = Math.abs(ebitda - expected) <= CURRENCY_TOL;
  return {
    id: `ebitda.${period}`,
    label: "EBITDA reconciliation",
    identity: "EBITDA = operating profit + depreciation & amortisation",
    passed,
    detail: `${gbp(ebit)} + ${gbp(da)} = ${gbp(expected)} vs reported ${gbp(ebitda)}`,
  };
}

// net debt including leases = total borrowings + lease liabilities (total) - cash (WP-BE23).
function netDebtIncludingLeasesCheck(facts: Record<string, Fact>, period: string): CheckResult | null {
  const b = num(facts, "borrowings", period);
  const l = num(facts, "leaseLiabilitiesTotal", period);
  const c = num(facts, "cash", period);
  const nd = num(facts, "netDebtIncludingLeases", period);
  if (b === null || l === null || c === null || nd === null) return null;
  const expected = b + l - c;
  const passed = Math.abs(nd - expected) <= CURRENCY_TOL;
  return {
    id: `net-debt-including-leases.${period}`,
    label: "Net debt including leases reconciliation",
    identity: "net debt including leases = total borrowings + lease liabilities (total) - cash",
    passed,
    detail: `${gbp(b)} + ${gbp(l)} - ${gbp(c)} = ${gbp(expected)} vs reported ${gbp(nd)}`,
  };
}

// leverage = net debt / EBITDA, with the net debt the ladder pairs (WP-BE23): including leases
// where that figure is on the sheet, else excluding leases. Checking against the other one would
// call a correct lease-paired leverage a contradiction.
function leverageCheck(facts: Record<string, Fact>, period: string): CheckResult | null {
  const incl = num(facts, "netDebtIncludingLeases", period);
  const nd = incl ?? num(facts, "netDebt", period);
  const which = incl !== null ? "net debt including leases" : "net debt excluding leases";
  const ebitda = num(facts, "ebitda", period);
  const lev = num(facts, "leverage", period);
  if (nd === null || ebitda === null || lev === null || ebitda === 0) return null;
  const expected = Math.round((nd / ebitda) * 100) / 100;
  const passed = Math.abs(lev - expected) <= RATIO_TOL;
  return {
    id: `leverage.${period}`,
    label: "Leverage reconciliation",
    identity: `leverage = ${which} / EBITDA`,
    passed,
    detail: `${gbp(nd)} / ${gbp(ebitda)} = ${expected.toFixed(2)}x vs reported ${lev.toFixed(2)}x`,
  };
}

// interest cover = EBITDA / interest expense (gross; interest income is not netted off).
function interestCoverCheck(facts: Record<string, Fact>, period: string): CheckResult | null {
  const ebitda = num(facts, "ebitda", period);
  const ni = num(facts, "netInterest", period);
  const cover = num(facts, "interestCover", period);
  if (ebitda === null || ni === null || cover === null || ni === 0) return null;
  const expected = Math.round((ebitda / ni) * 100) / 100;
  const passed = Math.abs(cover - expected) <= RATIO_TOL;
  return {
    id: `interest-cover.${period}`,
    label: "Interest cover reconciliation",
    identity: "interest cover = EBITDA / interest expense",
    passed,
    detail: `${gbp(ebitda)} / ${gbp(ni)} = ${expected.toFixed(2)}x vs reported ${cover.toFixed(2)}x`,
  };
}

// gross profit - operating profit = overheads (a non-negative bridge). Only runs where both
// lines are present; catches an operating profit that exceeds gross profit, which cannot be.
function operatingBridgeCheck(facts: Record<string, Fact>, period: string): CheckResult | null {
  const gp = num(facts, "grossProfit", period);
  const op = num(facts, "operatingProfit", period);
  if (gp === null || op === null) return null;
  const overheads = gp - op;
  const passed = overheads >= -CURRENCY_TOL;
  return {
    id: `operating-bridge.${period}`,
    label: "Operating bridge sanity",
    identity: "gross profit - operating profit = overheads (>= 0)",
    passed,
    detail: `${gbp(gp)} - ${gbp(op)} = ${gbp(overheads)} overheads`,
  };
}

// Run every enriched identity that the facts support, for one period.
export function runEnrichedChecks(
  facts: Record<string, Fact>,
  period: string
): CheckResult[] {
  const candidates = [
    netDebtCheck(facts, period),
    netDebtIncludingLeasesCheck(facts, period),
    ebitdaCheck(facts, period),
    leverageCheck(facts, period),
    interestCoverCheck(facts, period),
    operatingBridgeCheck(facts, period),
  ];
  return candidates.filter((c): c is CheckResult => c !== null);
}

// ---------------------------------------------------------------------------
// 2) Cross-source contradiction detection
// ---------------------------------------------------------------------------
// A contradiction is two (or more) facts for the SAME metric+period whose numeric values
// disagree beyond tolerance. Within a single manifest the fact map is keyed by metric.period
// so this cannot arise; it surfaces when facts from several sources or manifests are pooled.
// Contradictions are always surfaced, never silently reconciled.

export interface ContradictionValue {
  factId: string;
  value: number;
  sourceId: string | null;
  tag: string | null;
}

export interface Contradiction {
  metric: string;
  period: string;
  values: ContradictionValue[];
  spread: number; // max - min across the disagreeing values
  detail: string;
}

// Tolerance for "agree": a relative band with a small absolute floor, so both large currency
// figures and small ratios behave sensibly.
export function withinTolerance(a: number, b: number, relative = 0.005, absolute = 1): boolean {
  const diff = Math.abs(a - b);
  if (diff <= absolute) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return diff <= scale * relative;
}

// A comparator that returns 0 on a tie, as Array.prototype.sort requires.
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function detectContradictions(
  facts: Fact[],
  opts: { relative?: number; absolute?: number } = {}
): Contradiction[] {
  const groups = new Map<string, Fact[]>();
  for (const f of facts) {
    if (typeof f.value !== "number") continue; // only numeric facts can contradict
    // The key keeps metric and period apart: metrics such as securedVintage.7 and
    // insolvency.administration carry dots of their own, so splitting "metric.period" on the
    // first dot put half the metric in the period (WP-QA05).
    const key = `${f.metric}\u0000${f.period}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(f);
    groups.set(key, bucket);
  }

  const out: Contradiction[] = [];
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    const values = group.map((f) => f.value as number);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const agree = withinTolerance(min, max, opts.relative, opts.absolute);
    if (agree) continue; // every value is within tolerance of every other; no contradiction
    const { metric, period } = group[0];
    out.push({
      metric,
      period,
      values: group.map((f) => ({
        factId: f.id,
        value: f.value as number,
        sourceId: f.provenance?.sourceId ?? null,
        tag: f.provenance?.tag ?? null,
      })),
      spread: max - min,
      detail: `${metric} (${period}): values ${values
        .map((v) => v.toLocaleString("en-GB"))
        .join(" vs ")} differ beyond tolerance (spread ${(max - min).toLocaleString("en-GB")})`,
    });
  }
  // Deterministic ordering.
  out.sort((a, b) => compareText(a.metric, b.metric) || compareText(a.period, b.period));
  return out;
}

// ---------------------------------------------------------------------------
// 3) Independence / corroboration ladder (I0 .. I5)
// ---------------------------------------------------------------------------
// The doctrine: "corroborated" means two INDEPENDENT sources agree. Independence is by
// sourceId - the same document cited twice is one source, not two, and never corroborates.
// A derived line (sourceId "derived") is not an independent source; it is computed from the
// same underlying facts, so it is excluded from the independent-source count. This is
// deliberately conservative: we would rather under-claim corroboration than over-claim it.
//
//   I0  no support (no fact, or an abstain with no value)
//   I1  single source (one independent source, or several citations of the same source)
//   I2  two independent sources agreeing        -> corroborated
//   I3  three independent sources agreeing       -> corroborated
//   I4  four independent sources agreeing        -> corroborated
//   I5  five or more independent sources agreeing-> corroborated
//
// If independent sources disagree (a contradiction), corroboration is NOT awarded: the level
// falls back to I1 and the note flags the conflict. Agreement is unresolved, so the honest
// answer is "conflicting, not corroborated".

export type IndependenceLevel = "I0" | "I1" | "I2" | "I3" | "I4" | "I5";

export interface CorroborationState {
  entity: string;
  metric: string;
  period: string;
  level: IndependenceLevel;
  label: string; // "corroborated" only at I2+, else "single-source" / "unsupported" / "conflicting"
  corroborated: boolean; // convenience mirror of level >= I2
  independentSources: string[]; // the distinct sourceIds that agree
  note: string;
}

function levelFromCount(count: number): IndependenceLevel {
  if (count <= 0) return "I0";
  if (count === 1) return "I1";
  if (count === 2) return "I2";
  if (count === 3) return "I3";
  if (count === 4) return "I4";
  return "I5";
}

// Classify how a single metric+period is supported across a pool of facts.
export function corroborationState(
  facts: Fact[],
  entity: string,
  metric: string,
  period: string
): CorroborationState {
  const relevant = facts.filter(
    (f) => f.metric === metric && f.period === period && typeof f.value === "number"
  );

  const base = { entity, metric, period, corroborated: false as boolean };

  if (relevant.length === 0) {
    return {
      ...base,
      level: "I0",
      label: "unsupported",
      independentSources: [],
      note: "No source carries a value for this metric and period.",
    };
  }

  // Independent sources: distinct sourceIds, excluding derived lines and provenance-less facts.
  const independentIds = new Set<string>();
  for (const f of relevant) {
    const sid = f.provenance?.sourceId;
    if (sid && sid !== "derived") independentIds.add(sid);
  }

  // Do the independent sources actually agree? Compare the values behind distinct sources.
  const values = relevant
    .filter((f) => f.provenance?.sourceId && f.provenance.sourceId !== "derived")
    .map((f) => f.value as number);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 0;
  const agree = values.length <= 1 || withinTolerance(min, max);

  if (independentIds.size >= 2 && !agree) {
    // Genuinely independent sources exist but they disagree: this is a conflict, not
    // corroboration. Never award the label.
    return {
      ...base,
      level: "I1",
      label: "conflicting",
      independentSources: [...independentIds].sort(),
      note: `Two or more independent sources disagree (spread ${(max - min).toLocaleString(
        "en-GB"
      )}); corroboration withheld.`,
    };
  }

  const level = levelFromCount(independentIds.size);
  const corroborated = independentIds.size >= 2;
  const label = corroborated
    ? "corroborated"
    : independentIds.size === 1
      ? "single-source"
      : "unsupported";
  const note = corroborated
    ? `${independentIds.size} independent sources agree within tolerance.`
    : independentIds.size === 1
      ? "Only one independent source; a single unchecked source is never corroborated."
      : "Only derived or provenance-less values are present; no independent source.";

  return {
    ...base,
    level,
    label,
    corroborated,
    independentSources: [...independentIds].sort(),
    note,
  };
}
