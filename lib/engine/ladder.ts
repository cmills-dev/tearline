// lib/engine/ladder.ts
// The Resolution Ladder. Every derived field resolves through a strict, labelled
// sequence and NEVER renders a blank:
//
//   R1 REPORTED     verbatim from a source (handled upstream; base facts arrive R1)
//   R2 SYNTHESISED  computed from R1 facts via a declared formula
//   R3 PROXY        a related figure stands in, with an explicit bias flag
//   R4 ABSTAIN      no defensible value; an attempt log is retained
//
// The mechanism here consumes a pool of base (R1) facts and produces a resolved Fact
// at the highest rung achievable, recording every rung it tried.

import type {
  AttemptLogEntry,
  Derivation,
  Fact,
  FactValueKind,
  ProxyInfo,
  Provenance,
} from "./types";
import { scanReadAdmissible } from "./types";
import { contentHash } from "./hash";

export interface ResolverContext {
  base: Record<string, Fact>; // reported (R1) facts keyed by metric, one period
  period: string;
  // True when the source asked for the lease lines (the Companies House vision reader always
  // does). Then a lease line that was not read means leverage cannot be paired and abstains,
  // rather than falling back to net debt excluding leases (WP-BE23).
  leasesRead?: boolean;
}

// An attempt returns either a resolution or null (fall through to the next rung).
export interface R2Attempt {
  value: number;
  unit: string;
  derivation: Derivation;
  // provenance is composed from the inputs' sources (multi-source derived line)
  provenanceFrom: string[]; // input metric keys
}

export interface R3Attempt {
  value: number;
  unit: string;
  proxy: ProxyInfo;
  sourceMetric: string; // the base metric borrowed as the proxy
  derivation?: Derivation;
}

export interface MetricResolver {
  metric: string;
  label: string;
  kind: FactValueKind;
  unit: string;
  // R1: is the metric itself reported? (rare for derived lines, common for raw lines)
  r1?: (ctx: ResolverContext) => Fact | null;
  r2?: (ctx: ResolverContext) => R2Attempt | null;
  r3?: (ctx: ResolverContext) => R3Attempt | null;
  // Why R2 declined when its inputs ARE reported (a currency mismatch, a denominator at or below
  // zero). Without it the attempt log said the inputs were missing, which was not true.
  r2Declined?: (ctx: ResolverContext) => string | null;
}

function has(ctx: ResolverContext, key: string): boolean {
  const f = ctx.base[key];
  return !!f && typeof f.value === "number";
}
function num(ctx: ResolverContext, key: string): number {
  return ctx.base[key].value as number;
}
// The one unit a set of reported inputs shares, or null when they disagree. A derived figure
// carries its inputs' currency: EBITDA was hard-labelled GBP, so a USD filer's EBITDA rendered
// under a pound sign, and a USD and a GBP input were added together (WP-QA03 N4).
function sharedUnit(ctx: ResolverContext, ...keys: string[]): string | null {
  const units = new Set(keys.map((k) => ctx.base[k]?.unit ?? ""));
  return units.size === 1 ? [...units][0] : null;
}
function unitClash(ctx: ResolverContext, ...keys: string[]): string | null {
  if (!keys.every((k) => has(ctx, k)) || sharedUnit(ctx, ...keys) !== null) return null;
  return `Inputs are reported in different units (${keys.map((k) => `${k} ${ctx.base[k].unit}`).join(", ")}); no figure is computed across a currency change.`;
}

// Compose a derived-line provenance out of its input facts. A synthesised value is
// "DERIVED" and internally consistent by construction; its evidence card points back
// at each input's own source.
function derivedProvenance(
  ctx: ResolverContext,
  inputs: string[],
  formula: string
): Provenance {
  const parts = inputs
    .map((k) => {
      const p = ctx.base[k]?.provenance;
      return p ? `${ctx.base[k].label}: ${p.documentName} (${p.locator})` : k;
    })
    .join("; ");
  return {
    sourceId: "derived",
    tag: "Acc",
    documentName: "Derived line (see inputs)",
    locator: formula,
    snippet: `Computed from: ${parts}`,
    retrievedAt: ctx.base[inputs[0]]?.provenance?.retrievedAt ?? "",
    // A derived line is traceable too: hash the formula and the exact inputs it was computed from,
    // so a derived fact's provenance carries a real content hash rather than an empty string.
    contentHash: contentHash(`derived|${formula}|${parts}`),
  };
}

// The rung rule for figures read off a scan (WP-BE05). A scan-read fact without the
// "double-read" tag is a single read, and a single read never holds a value at any rung: it is
// not an R1 fact, not an input to an R2 formula and not an R3 proxy. It is dropped from the base
// pool here, so a resolver cannot see it at all. There is no flag that admits it.
export function admissibleBase(base: Record<string, Fact>): Record<string, Fact> {
  const out: Record<string, Fact> = {};
  for (const [k, f] of Object.entries(base)) {
    if (scanReadAdmissible(f.provenance)) out[k] = f;
  }
  return out;
}

export function resolveMetric(
  resolver: MetricResolver,
  context: ResolverContext
): Fact {
  const attemptLog: AttemptLogEntry[] = [];
  const ctx: ResolverContext = { ...context, base: admissibleBase(context.base) };

  // --- R1 -------------------------------------------------------------------
  if (resolver.r1) {
    const r1 = resolver.r1(ctx);
    if (r1 && scanReadAdmissible(r1.provenance)) {
      return { ...r1, rung: "R1" };
    }
    attemptLog.push({
      step: "R1 reported",
      outcome: "missing",
      detail: `No line reported as "${resolver.label}" in entitled sources.`,
    });
  }

  // --- R2 -------------------------------------------------------------------
  if (resolver.r2) {
    const r2 = resolver.r2(ctx);
    if (r2) {
      return {
        id: `${resolver.metric}.${ctx.period}`,
        metric: resolver.metric,
        label: resolver.label,
        period: ctx.period,
        kind: resolver.kind,
        value: r2.value,
        unit: r2.unit,
        rung: "R2",
        provenance: derivedProvenance(
          ctx,
          r2.provenanceFrom,
          r2.derivation.formula
        ),
        derivation: r2.derivation,
        verification: {
          status: "DERIVED",
          checks: [
            {
              id: `${resolver.metric}-derivation`,
              label: "Derivation",
              identity: r2.derivation.formula,
              passed: true,
              detail: "Value is consistent with its inputs by construction.",
            },
          ],
        },
        attemptLog,
      };
    }
    attemptLog.push({
      step: "R2 synthesised",
      outcome: "insufficient",
      detail: resolver.r2Declined?.(ctx) ?? "Inputs for the declared formula are not all reported.",
    });
  }

  // --- R3 -------------------------------------------------------------------
  if (resolver.r3) {
    const r3 = resolver.r3(ctx);
    if (r3) {
      const src = ctx.base[r3.sourceMetric];
      attemptLog.push({
        step: "R3 proxy",
        outcome: "found",
        detail: `${r3.proxy.suppliedAs} substituted for ${r3.proxy.requested}.`,
      });
      return {
        id: `${resolver.metric}.${ctx.period}`,
        metric: resolver.metric,
        label: resolver.label,
        period: ctx.period,
        kind: resolver.kind,
        value: r3.value,
        unit: r3.unit,
        rung: "R3",
        provenance: src?.provenance ?? null,
        derivation: r3.derivation,
        proxy: r3.proxy,
        verification: {
          status: "SINGLE_SOURCE",
          checks: [
            {
              id: `${resolver.metric}-proxy`,
              label: "Proxy substitution",
              identity: `${r3.proxy.suppliedAs} used for ${r3.proxy.requested}`,
              passed: true,
              detail: `Bias: this ${r3.proxy.biasDirection} the true figure. ${r3.proxy.biasNote}`,
            },
          ],
        },
        attemptLog,
      };
    }
    attemptLog.push({
      step: "R3 proxy",
      outcome: "missing",
      detail: "No acceptable proxy available in entitled sources.",
    });
  }

  // --- R4 -------------------------------------------------------------------
  attemptLog.push({
    step: "R4 abstain",
    outcome: "insufficient",
    detail:
      "Every higher rung was attempted and failed. Abstaining rather than guessing.",
  });
  return {
    id: `${resolver.metric}.${ctx.period}`,
    metric: resolver.metric,
    label: resolver.label,
    period: ctx.period,
    kind: resolver.kind,
    value: null,
    unit: resolver.unit,
    rung: "R4",
    provenance: null,
    verification: { status: "NOT_APPLICABLE", checks: [] },
    attemptLog,
  };
}

// ---------------------------------------------------------------------------
// Standard reusable resolvers for common derived credit metrics.
// ---------------------------------------------------------------------------

export const ebitdaResolver: MetricResolver = {
  metric: "ebitda",
  label: "EBITDA",
  kind: "currency",
  unit: "GBP",
  r2: (ctx) => {
    const unit = sharedUnit(ctx, "operatingProfit", "depreciationAmortisation");
    if (has(ctx, "operatingProfit") && has(ctx, "depreciationAmortisation") && unit !== null) {
      return {
        value: num(ctx, "operatingProfit") + num(ctx, "depreciationAmortisation"),
        unit,
        derivation: {
          formula: "EBITDA = Operating profit + Depreciation & amortisation",
          inputs: [
            `operatingProfit.${ctx.period}`,
            `depreciationAmortisation.${ctx.period}`,
          ],
        },
        provenanceFrom: ["operatingProfit", "depreciationAmortisation"],
      };
    }
    return null;
  },
  r3: (ctx) => {
    // EBIT (operating profit) stands in for EBITDA. EBITDA = EBIT + D&A >= EBIT,
    // so EBIT understates EBITDA.
    if (has(ctx, "operatingProfit")) {
      return {
        value: num(ctx, "operatingProfit"),
        unit: ctx.base["operatingProfit"].unit,
        sourceMetric: "operatingProfit",
        proxy: {
          requested: "EBITDA",
          suppliedAs: "EBIT (Operating profit)",
          biasDirection: "understates",
          biasNote:
            "Depreciation and amortisation are not separately disclosed, so the add-back cannot be made.",
        },
      };
    }
    return null;
  },
  r2Declined: (ctx) => unitClash(ctx, "operatingProfit", "depreciationAmortisation"),
};

// Net debt is printed twice (WP-BE23, docs/decisions/2026-09-24-lease-liabilities-confirmed.md):
// including lease liabilities, which the sheet leads with, and excluding them, the lender
// covenant form. Each is named for what it is, so neither number changes meaning by filer.
export const netDebtResolver: MetricResolver = {
  metric: "netDebt",
  label: "Net debt excluding leases",
  kind: "currency",
  unit: "GBP",
  r2: (ctx) => {
    const unit = sharedUnit(ctx, "borrowings", "cash");
    if (has(ctx, "borrowings") && has(ctx, "cash") && unit !== null) {
      return {
        value: num(ctx, "borrowings") - num(ctx, "cash"),
        unit,
        derivation: {
          formula: "Net debt excluding leases = Total borrowings − Cash and cash equivalents",
          inputs: [`borrowings.${ctx.period}`, `cash.${ctx.period}`],
        },
        provenanceFrom: ["borrowings", "cash"],
      };
    }
    return null;
  },
  r2Declined: (ctx) => unitClash(ctx, "borrowings", "cash"),
};

export const netDebtIncludingLeasesResolver: MetricResolver = {
  metric: "netDebtIncludingLeases",
  label: "Net debt including leases",
  kind: "currency",
  unit: "GBP",
  r2: (ctx) => {
    const unit = sharedUnit(ctx, "borrowings", "leaseLiabilitiesTotal", "cash");
    if (has(ctx, "borrowings") && has(ctx, "leaseLiabilitiesTotal") && has(ctx, "cash") && unit !== null) {
      return {
        value: num(ctx, "borrowings") + num(ctx, "leaseLiabilitiesTotal") - num(ctx, "cash"),
        unit,
        derivation: {
          formula: "Net debt including leases = Total borrowings + Lease liabilities (total) − Cash and cash equivalents",
          inputs: [`borrowings.${ctx.period}`, `leaseLiabilitiesTotal.${ctx.period}`, `cash.${ctx.period}`],
        },
        provenanceFrom: ["borrowings", "leaseLiabilitiesTotal", "cash"],
      };
    }
    return null;
  },
  r2Declined: (ctx) => unitClash(ctx, "borrowings", "leaseLiabilitiesTotal", "cash"),
};

// The lease total, when the filing prints the current and non-current lines but no total. A
// printed total lands at R1 and is never replaced by this. The split lines are never derived
// from the total.
export const leaseLiabilitiesTotalResolver: MetricResolver = {
  metric: "leaseLiabilitiesTotal",
  label: "Lease liabilities (total)",
  kind: "currency",
  unit: "GBP",
  r2: (ctx) => {
    const unit = sharedUnit(ctx, "leaseLiabilitiesCurrent", "leaseLiabilitiesNonCurrent");
    if (has(ctx, "leaseLiabilitiesCurrent") && has(ctx, "leaseLiabilitiesNonCurrent") && unit !== null) {
      return {
        value: num(ctx, "leaseLiabilitiesCurrent") + num(ctx, "leaseLiabilitiesNonCurrent"),
        unit,
        derivation: {
          formula: "Lease liabilities (total) = Lease liabilities due within one year + Lease liabilities due after more than one year",
          inputs: [`leaseLiabilitiesCurrent.${ctx.period}`, `leaseLiabilitiesNonCurrent.${ctx.period}`],
          note: "Derived, not printed: the filing prints the current and non-current lines but no total.",
        },
        provenanceFrom: ["leaseLiabilitiesCurrent", "leaseLiabilitiesNonCurrent"],
      };
    }
    return null;
  },
  r2Declined: (ctx) => unitClash(ctx, "leaseLiabilitiesCurrent", "leaseLiabilitiesNonCurrent"),
};

// Leverage pairs like with like (WP-BE23, RS-01). EBITDA here is operating profit plus all
// depreciation and amortisation, so where leases are on the balance sheet it is before lease
// costs (right-of-use depreciation is added back). The net debt it divides must then include
// the lease liabilities. Before WP-BE23 it divided net debt excluding leases, which matches no
// convention and understates leverage for lease-heavy filers.
//   - Lease total on the sheet: net debt including leases / EBITDA.
//   - The source asked for leases and the total was not resolved: abstain. Pairing EBITDA before
//     lease costs with debt that leaves the leases out is the defect this replaces.
//   - The source does not read leases at all (SEC, iXBRL, ESEF today): net debt excluding leases
//     / EBITDA, and the derivation says no lease liability is on the sheet. That is like with like
//     only where EBITDA is after lease costs, which the engine cannot see; the note says so.
export const leverageResolver: MetricResolver = {
  metric: "leverage",
  label: "Leverage (Net debt / EBITDA)",
  kind: "ratio",
  unit: "x",
  // Requires a resolved EBITDA already placed into the base pool under "ebitda".
  r2: (ctx) => {
    // EBITDA at or below zero makes the multiple meaningless: -4x, or net cash over a loss
    // reading as a healthy positive multiple. Abstain with that reason (WP-QA03 N3).
    if (!has(ctx, "ebitda") || num(ctx, "ebitda") <= 0) return null;
    const proxyNote = ctx.base["ebitda"].rung === "R3" ? " EBITDA input is an R3 proxy; the ratio inherits that proxy's bias." : "";
    if (has(ctx, "netDebtIncludingLeases")) {
      const unit = sharedUnit(ctx, "netDebtIncludingLeases", "ebitda");
      if (unit === null) return null;
      return {
        value: Math.round((num(ctx, "netDebtIncludingLeases") / num(ctx, "ebitda")) * 100) / 100,
        unit: "x",
        derivation: {
          formula: "Leverage = Net debt including leases ÷ EBITDA",
          inputs: [`netDebtIncludingLeases.${ctx.period}`, `ebitda.${ctx.period}`],
          note: `Like with like: EBITDA adds back all depreciation, including right-of-use assets, so it is before lease costs, and the net debt includes the lease liabilities.${proxyNote}`,
        },
        provenanceFrom: ["netDebtIncludingLeases", "ebitda"],
      };
    }
    if (ctx.leasesRead || ctx.base["leaseLiabilitiesTotal"] || ctx.base["leaseLiabilitiesCurrent"] || ctx.base["leaseLiabilitiesNonCurrent"]) return null;
    if (has(ctx, "netDebt") && sharedUnit(ctx, "netDebt", "ebitda") !== null) {
      return {
        value: Math.round((num(ctx, "netDebt") / num(ctx, "ebitda")) * 100) / 100,
        unit: "x",
        derivation: {
          formula: "Leverage = Net debt excluding leases ÷ EBITDA",
          inputs: [`netDebt.${ctx.period}`, `ebitda.${ctx.period}`],
          note: `No lease liability is on this sheet: this source does not read leases, so neither figure includes them. Like with like only if EBITDA is after lease costs; for a filer that carries leases on its balance sheet it understates leverage.${proxyNote}`,
        },
        provenanceFrom: ["netDebt", "ebitda"],
      };
    }
    return null;
  },
  r2Declined: (ctx) => {
    const nd = has(ctx, "netDebtIncludingLeases") ? "netDebtIncludingLeases" : "netDebt";
    if (has(ctx, nd) && has(ctx, "ebitda") && num(ctx, "ebitda") <= 0) {
      return "EBITDA is zero or negative, so net debt over EBITDA is not a meaningful multiple.";
    }
    return unitClash(ctx, nd, "ebitda");
  },
};

export const interestCoverResolver: MetricResolver = {
  metric: "interestCover",
  // The denominator is GROSS interest expense (SEC InterestExpense, iXBRL interest payable /
  // finance costs, ESEF finance costs), not interest net of interest income. Interest income is
  // not reliably tagged, so we do not net it off and we do not claim to: the label says exactly
  // what the number is, an interest-expense cover, rather than overstating it as net interest.
  label: "Interest cover (EBITDA / interest expense)",
  kind: "ratio",
  unit: "x",
  r2: (ctx) => {
    if (
      has(ctx, "ebitda") &&
      has(ctx, "netInterest") &&
      num(ctx, "netInterest") !== 0
    ) {
      const cover =
        Math.round((num(ctx, "ebitda") / num(ctx, "netInterest")) * 100) / 100;
      return {
        value: cover,
        unit: "x",
        derivation: {
          formula: "Interest cover = EBITDA ÷ Interest expense",
          inputs: [`ebitda.${ctx.period}`, `netInterest.${ctx.period}`],
        },
        provenanceFrom: ["ebitda", "netInterest"],
      };
    }
    return null;
  },
};

// UK balance sheets print borrowings split by maturity, not as a total (audit BE-17). The
// vision reader transcribes the two printed lines and never adds them, so the addition happens
// here, at R2, with the formula and both inputs on the record. Off by default: only a source
// that supplies the split asks for it (see DEFAULT_DERIVED in buildManifest.ts).
export const borrowingsResolver: MetricResolver = {
  metric: "borrowings",
  label: "Total borrowings",
  kind: "currency",
  unit: "GBP",
  r2: (ctx) => {
    if (has(ctx, "borrowingsWithinOneYear") && has(ctx, "borrowingsAfterOneYear")) {
      return {
        value: num(ctx, "borrowingsWithinOneYear") + num(ctx, "borrowingsAfterOneYear"),
        unit: "GBP",
        derivation: {
          formula: "Total borrowings = Borrowings due within one year + Borrowings due after more than one year",
          inputs: [`borrowingsWithinOneYear.${ctx.period}`, `borrowingsAfterOneYear.${ctx.period}`],
          note: "Lease liabilities, preference shares and shareholder loans are held separately and are not in this total.",
        },
        provenanceFrom: ["borrowingsWithinOneYear", "borrowingsAfterOneYear"],
      };
    }
    return null;
  },
  r3: (ctx) => {
    // Only one maturity band was printed. The other may be nil or may simply not have been
    // read, and the accounts do not say which, so the single band stands in and is marked as
    // understating the total.
    for (const key of ["borrowingsAfterOneYear", "borrowingsWithinOneYear"]) {
      if (has(ctx, key) && !has(ctx, key === "borrowingsAfterOneYear" ? "borrowingsWithinOneYear" : "borrowingsAfterOneYear")) {
        const band = key === "borrowingsAfterOneYear" ? "after more than one year" : "within one year";
        return {
          value: num(ctx, key),
          unit: "GBP",
          sourceMetric: key,
          proxy: {
            requested: "Total borrowings",
            suppliedAs: `Borrowings falling due ${band}`,
            biasDirection: "understates",
            biasNote: "Only one maturity band was read from the accounts, so any borrowings in the other band are missing.",
          },
        };
      }
    }
    return null;
  },
};
