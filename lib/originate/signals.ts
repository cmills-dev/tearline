// lib/originate/signals.ts
// The "why now" layer of origination: deterministic, individually-cited catalyst and fit
// signals computed from the FactManifest we already produce. Each Signal carries the exact
// Provenance of the fact it is derived from and its resolution rung; a signal with no
// citation is dropped into `abstentions`, never into `whyNow`. Nothing here is inferred
// without a source, so the engine can only ever surface an auditable reason.

import type { FactManifest, Fact, Provenance } from "../engine/types";

export type SignalCategory = "timing" | "condition" | "fit";
export type SignalDirection = "positive" | "negative" | "neutral";

export interface Signal {
  id: string;
  type: string;
  category: SignalCategory;
  label: string;
  detail: string;
  direction: SignalDirection;
  source: Provenance | null; // the exact fact provenance; null => abstained, excluded from whyNow
  caveat?: string;
  rung: Fact["rung"];
}

export interface MandateLike {
  sectors?: string[]; // SIC prefixes or sector keys
  minTurnover?: number;
  maxTurnover?: number;
  maxLeverage?: number;
}

// Detection options. The maturity PROXY threshold is configurable; the default (c. 5 years)
// is the age past which an outstanding secured charge is worth checking as a refinancing
// candidate. It is an age, not a maturity date - Companies House charges carry no end date.
export interface SignalOptions {
  maturityVintageYears?: number;
}
const DEFAULT_MATURITY_VINTAGE_YEARS = 5;

function factOf(m: FactManifest, metric: string): Fact | undefined {
  return Object.values(m.facts).find((f) => f.metric === metric && f.value !== null);
}
function num(f: Fact | undefined): number | null {
  return f && typeof f.value === "number" ? f.value : null;
}
// The first landed, cited fact whose metric starts with `prefix` (a namespace such as
// "insolvency." or "securedVintage.").
function firstNsFact(m: FactManifest, prefix: string): Fact | undefined {
  return Object.values(m.facts).find(
    (f) => f.metric.startsWith(prefix) && f.value !== null && !!f.provenance
  );
}
// Whole/fractional years between an ISO date and today. Null when unparseable.
function yearsSince(isoDate: string): number | null {
  const then = Date.parse(isoDate);
  if (!Number.isFinite(then)) return null;
  const ms = Date.now() - then;
  if (ms < 0) return 0;
  return ms / (365.25 * 24 * 60 * 60 * 1000);
}

// Compute the catalyst + fit signals for one target. Returns the signals that ARE cited
// (usable as "why now") and the honest abstentions (what we could not establish).
export function detectSignals(
  m: FactManifest,
  mandate: MandateLike = {},
  opts: SignalOptions = {}
): { signals: Signal[]; abstentions: string[] } {
  const signals: Signal[] = [];
  const abstentions: string[] = [];
  const period = Object.values(m.facts)[0]?.period ?? "";

  const push = (s: Omit<Signal, "id">) => {
    const id = `${s.type}.${period}`;
    if (s.source) signals.push({ ...s, id });
    else abstentions.push(`${s.label}: not established from the record`);
  };

  // --- Condition signals (credit catalysts) ---
  // Leverage is a "why now" only when it is ELEVATED. A conservatively-geared balance sheet
  // (< c. 3x) is not a refinancing/restructuring catalyst, so it is never surfaced as a reason
  // to approach a target - it would rank a healthy company on "leverage 0.80x". The signal fires
  // in the neutral band (c. 3-5x, worth checking) and the negative band (>= 5x, a real catalyst);
  // below the threshold the leverage is simply left off the "why now" list, not abstained.
  const LEVERAGE_CATALYST_MIN = 3;
  const lev = factOf(m, "leverage");
  const levV = num(lev);
  if (levV !== null && levV >= LEVERAGE_CATALYST_MIN) {
    push({
      type: "high_leverage",
      category: "condition",
      label: "Leverage",
      detail: `Net leverage ${levV.toFixed(2)}x`,
      direction: levV >= 5 ? "negative" : "neutral",
      source: lev!.provenance,
      caveat: levV >= 5 ? "Elevated leverage is a refinancing/restructuring catalyst, not a distress verdict on its own." : "Moderate leverage, a refinancing candidate to check rather than a distress signal.",
      rung: lev!.rung,
    });
  }

  const cover = factOf(m, "interestCover");
  const coverV = num(cover);
  if (coverV !== null && coverV < 3) {
    push({
      type: "thin_cover",
      category: "condition",
      label: "Interest cover",
      detail: `Interest cover ${coverV.toFixed(1)}x`,
      direction: "negative",
      source: cover!.provenance,
      caveat: "Thin cover raises refinancing sensitivity to rates.",
      rung: cover!.rung,
    });
  }

  // --- Timing signal: secured debt on the register (a refinancing candidate + a lender
  // relationship to trace). Derived from charge facts, each carrying provenance. ---
  const charges = Object.values(m.facts).filter((f) => f.metric.startsWith("charge") && f.value !== null);
  const outstanding = charges.filter((c) => String(c.value).toLowerCase().includes("outstanding"));
  if (outstanding.length > 0) {
    push({
      type: "secured_debt",
      category: "timing",
      label: "Secured debt outstanding",
      detail: `${outstanding.length} outstanding secured charge${outstanding.length > 1 ? "s" : ""} on the register`,
      direction: "neutral",
      source: outstanding[0].provenance,
      caveat: "Asset-heavy firms carry charges normally; a signal to trace the lender, not a distress verdict.",
      rung: outstanding[0].rung,
    });
  }

  // --- Timing signal: maturity / refinancing-window PROXY. Companies House charges carry
  // NO maturity or end date, so this is honestly the VINTAGE (age) of an outstanding
  // charge, labelled a proxy, never a maturity date. Reads the securedVintage.* companion
  // facts, which exist only for outstanding, dated charges. Abstains when none carries a
  // created_on to proxy from. ---
  const thresholdYears = opts.maturityVintageYears ?? DEFAULT_MATURITY_VINTAGE_YEARS;
  const vintages = Object.values(m.facts)
    .filter((f) => f.metric.startsWith("securedVintage") && typeof f.value === "string" && f.value && f.provenance)
    .map((f) => ({ f, created: String(f.value), ageYears: yearsSince(String(f.value)) }))
    .filter((v) => v.ageYears !== null) as { f: Fact; created: string; ageYears: number }[];
  if (vintages.length === 0) {
    abstentions.push("Maturity/refinancing window: no dated outstanding charge on the register to proxy from");
  } else {
    const aged = vintages.filter((v) => v.ageYears >= thresholdYears).sort((a, b) => b.ageYears - a.ageYears);
    if (aged.length > 0) {
      const oldest = aged[0];
      push({
        type: "maturity_window",
        category: "timing",
        label: "Maturity / refinancing window (vintage proxy)",
        detail: `${aged.length} outstanding secured charge${aged.length > 1 ? "s" : ""} created c. ${oldest.ageYears.toFixed(0)} years ago (oldest created ${oldest.created})`,
        direction: "neutral",
        source: oldest.f.provenance,
        caveat:
          "Vintage PROXY, not a maturity date. Companies House charges carry no maturity or end date, so this is the AGE of an outstanding charge. A long-dated charge is a refinancing candidate to check, never a confirmed maturity.",
        rung: oldest.f.rung,
      });
    } else {
      abstentions.push(`Maturity/refinancing window: outstanding charge(s) present but none older than the c. ${thresholdYears}-year vintage threshold`);
    }
  }

  // --- Condition signals: public distress. Each is cited to a real fact or it abstains;
  // none invents a catalyst. Absence of the underlying fact records an abstention. ---

  // Insolvency case on the register (a hard, cited distress catalyst).
  const ins = firstNsFact(m, "insolvency.");
  const insCount = Object.values(m.facts).filter((f) => f.metric.startsWith("insolvency.") && f.value !== null).length;
  push({
    type: "insolvency_case",
    category: "condition",
    label: "Insolvency proceedings",
    detail: ins ? `${insCount} insolvency case${insCount > 1 ? "s" : ""} on the register (${String(ins.value)})` : "",
    direction: "negative",
    source: ins?.provenance ?? null,
    caveat: "A filed insolvency case is a hard distress catalyst, cited to the Companies House insolvency record.",
    rung: ins?.rung ?? "R1",
  });

  // Company status other than active.
  const st = firstNsFact(m, "status.flag");
  push({
    type: "adverse_status",
    category: "condition",
    label: "Company status",
    detail: st ? `Company status is "${String(st.value)}", not active` : "",
    direction: "negative",
    source: st?.provenance ?? null,
    caveat: "A non-active register status is a cited distress flag, not a verdict on solvency by itself.",
    rung: st?.rung ?? "R1",
  });

  // Accounts overdue at Companies House.
  const ao = firstNsFact(m, "filing.accountsOverdue");
  push({
    type: "accounts_overdue",
    category: "condition",
    label: "Accounts overdue",
    detail: ao ? "Annual accounts are overdue at Companies House" : "",
    direction: "negative",
    source: ao?.provenance ?? null,
    caveat: "An overdue filing is a governance/distress flag to check, cited to the register.",
    rung: ao?.rung ?? "R1",
  });

  // Confirmation statement overdue at Companies House.
  const co = firstNsFact(m, "filing.confirmationOverdue");
  push({
    type: "confirmation_overdue",
    category: "condition",
    label: "Confirmation statement overdue",
    detail: co ? "Confirmation statement is overdue at Companies House" : "",
    direction: "negative",
    source: co?.provenance ?? null,
    caveat: "An overdue confirmation statement is a governance/distress flag, cited to the register.",
    rung: co?.rung ?? "R1",
  });

  // Net liabilities: net assets < 0 (cited to the balance-sheet fact). Abstains when net
  // assets are not disclosed; silent (not a catalyst) when net assets are non-negative.
  const na = factOf(m, "netAssets");
  const naV = num(na);
  if (naV === null) {
    abstentions.push("Net liabilities: net assets not disclosed");
  } else if (naV < 0) {
    push({
      type: "net_liabilities",
      category: "condition",
      label: "Net liabilities",
      detail: `Negative net assets of ${(naV / 1e6).toFixed(1)}m on the balance sheet`,
      direction: "negative",
      source: na!.provenance,
      caveat: "Negative net assets (balance-sheet insolvency) is a cited distress signal, not a cash-flow verdict.",
      rung: na!.rung,
    });
  }

  // Net current liabilities: net current assets < 0 (cited to the balance-sheet fact).
  const nca = factOf(m, "netCurrentAssets");
  const ncaV = num(nca);
  if (ncaV === null) {
    abstentions.push("Net current liabilities: net current assets not disclosed");
  } else if (ncaV < 0) {
    push({
      type: "net_current_liabilities",
      category: "condition",
      label: "Net current liabilities",
      detail: `Negative net current assets of ${(ncaV / 1e6).toFixed(1)}m (working-capital deficit)`,
      direction: "negative",
      source: nca!.provenance,
      caveat: "A working-capital deficit is a cited near-term liquidity signal, not a solvency verdict on its own.",
      rung: nca!.rung,
    });
  }

  // Going-concern material uncertainty (a TEXT-DERIVED heuristic on the ISA 570 phrase).
  const gc = firstNsFact(m, "goingConcern.materialUncertainty");
  push({
    type: "going_concern",
    category: "condition",
    label: "Going concern: material uncertainty",
    detail: gc ? "The accounts text carries the ISA 570 material-uncertainty phrase" : "",
    direction: "negative",
    source: gc?.provenance ?? null,
    caveat: "TEXT-DERIVED heuristic: matched the ISA 570 standardised phrase in the accounts text, not a filer-tagged concept. Read the note in full before relying on it.",
    rung: gc?.rung ?? "R3",
  });

  // --- Fit signals against the mandate (never a catalyst; a multiplier on ranking) ---
  const turnover = num(factOf(m, "turnover"));
  if (mandate.minTurnover !== undefined || mandate.maxTurnover !== undefined) {
    if (turnover === null) {
      abstentions.push("Size fit: turnover not disclosed");
    } else {
      const inBand =
        (mandate.minTurnover === undefined || turnover >= mandate.minTurnover) &&
        (mandate.maxTurnover === undefined || turnover <= mandate.maxTurnover);
      const tf = factOf(m, "turnover")!;
      push({
        type: "size_fit",
        category: "fit",
        label: "Size fit",
        detail: `Turnover ${(turnover / 1e6).toFixed(0)}m ${inBand ? "within" : "outside"} the mandate band`,
        direction: inBand ? "positive" : "negative",
        source: tf.provenance,
        rung: tf.rung,
      });
    }
  }

  const sector = factOf(m, "sector");
  if (mandate.sectors && mandate.sectors.length > 0 && sector) {
    const val = String(sector.value).toLowerCase();
    const hit = mandate.sectors.some((s) => val.includes(s.toLowerCase()));
    push({
      type: "sector_fit",
      category: "fit",
      label: "Sector fit",
      detail: hit ? "Sector matches the mandate" : "Sector outside the mandate",
      direction: hit ? "positive" : "negative",
      source: sector.provenance,
      rung: sector.rung,
    });
  }

  return { signals, abstentions };
}
