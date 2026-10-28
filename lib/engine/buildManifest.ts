// lib/engine/buildManifest.ts
// Turns a BorrowerFixture (raw reported facts, CH-shaped profile) into a fully
// resolved FactManifest: every reported line becomes an R1 Fact with a content hash,
// every declared derived metric is run through the resolution ladder per period, and
// cross-field structural checks are applied. This is the deterministic core that the
// UI and the language plane consume.

import type { BorrowerFixture, RawReportedFact } from "../sources/fixtures/types";
import { contentHash } from "./hash";
import {
  borrowingsResolver,
  ebitdaResolver,
  interestCoverResolver,
  leaseLiabilitiesTotalResolver,
  leverageResolver,
  MetricResolver,
  netDebtIncludingLeasesResolver,
  netDebtResolver,
  resolveMetric,
} from "./ladder";
import { runStructuralChecks } from "./verify";
import type { EntityMeta, Fact, FactManifest, SourceDocument } from "./types";

// A turnover resolver: reported (R1) if filed, otherwise straight to R4 abstain. This
// is what makes the filleted case abstain rather than invent a number.
const turnoverResolver: MetricResolver = {
  metric: "turnover",
  label: "Turnover",
  kind: "currency",
  unit: "GBP",
  r1: (ctx) => ctx.base["turnover"] ?? null,
};

const DERIVED_RESOLVERS: Record<string, MetricResolver> = {
  ebitda: ebitdaResolver,
  netDebt: netDebtResolver,
  netDebtIncludingLeases: netDebtIncludingLeasesResolver,
  leaseLiabilitiesTotal: leaseLiabilitiesTotalResolver,
  leverage: leverageResolver,
  interestCover: interestCoverResolver,
  turnover: turnoverResolver,
  borrowings: borrowingsResolver,
};

// Order matters: borrowings and the lease total must resolve before the two net debts, and
// ebitda and the net debts before leverage/interestCover, which consume them from the base pool.
const DERIVED_ORDER = ["turnover", "borrowings", "leaseLiabilitiesTotal", "ebitda", "netDebtIncludingLeases", "netDebt", "leverage", "interestCover"];

// What runs when a caller does not say. Borrowings is left out: only a source that reads the
// UK maturity split (the Companies House vision path) supplies its inputs, and a source that
// reports a borrowings total already lands it at R1.
// Net debt including leases is always attempted, so the sheet always prints both net debts; a
// source that reads no lease line shows it abstaining.
export const DEFAULT_DERIVED = ["turnover", "ebitda", "netDebtIncludingLeases", "netDebt", "leverage", "interestCover"];

// Everything, for a source that reads borrowings split by maturity and the lease lines. Listing
// leaseLiabilitiesTotal also tells leverage the source asked for leases (ResolverContext.leasesRead).
export const DERIVED_WITH_BORROWINGS_SPLIT = DERIVED_ORDER;

// Run the resolution ladder for the derived metrics on one period, in dependency order.
// Shared by the fixture path and the live Companies House path, so a real filing whose
// base lines were read from iXBRL synthesises EBITDA / net debt / leverage exactly the
// way a fixture does, and abstains identically where a base line is missing.
export function resolveDerivedMetrics(
  facts: Record<string, Fact>,
  periodKey: string,
  allowed: readonly string[] = DEFAULT_DERIVED
): void {
  for (const metric of DERIVED_ORDER) {
    if (!allowed.includes(metric)) continue;
    const resolver = DERIVED_RESOLVERS[metric];
    if (!resolver) continue;
    const base: Record<string, Fact> = {};
    for (const f of Object.values(facts)) {
      if (f.period === periodKey) base[f.metric] = f;
    }
    const resolved = resolveMetric(resolver, { base, period: periodKey, leasesRead: allowed.includes("leaseLiabilitiesTotal") });
    // Never clobber an already-present fact with a WORSE rung: a metric that is genuinely reported
    // (R1) or already synthesised (R2) must not be silently replaced by a lower-rung proxy or an
    // R4 abstain from the resolver. Only write when the resolved rung is strictly better, or when
    // nothing exists for that id yet.
    const rank: Record<string, number> = { R1: 0, R2: 1, R3: 2, R4: 3 };
    const existing = facts[resolved.id];
    if (!existing || rank[resolved.rung] < rank[existing.rung]) {
      facts[resolved.id] = resolved;
    }
  }
}

// The FY period key for a source line's own reporting-period end ("2024-03-31" -> "FY2024"),
// or null when the end date is absent. Live source mappers key each financial line under ITS
// OWN period rather than a single latest key, so a derived metric (leverage, interest cover) is
// only ever computed from base facts of the same fiscal year - a base line from another year
// lands under a different period and the resolver abstains instead of silently mixing years.
export function periodKeyForEnd(end: string | undefined | null): string | null {
  if (!end || end.length < 4) return null;
  return `FY${end.slice(0, 4)}`;
}

// Land already-extracted financial lines as R1 facts, each under its own period key, then run
// the derived-metric ladder and structural checks once per distinct period present (always
// including the primary period so its headline metrics resolve or abstain). mkFact builds the
// source-specific Fact (SEC/ESEF/CH differ in provenance). Returns the set of period keys used.
export function landFinancialLines<L extends { metric: string; periodEnd?: string }>(
  facts: Record<string, Fact>,
  lines: L[],
  primaryPk: string,
  mkFact: (line: L, periodKey: string) => Fact,
  allowed: readonly string[] = DEFAULT_DERIVED,
): Set<string> {
  const periodKeys = new Set<string>([primaryPk]);
  for (const line of lines) {
    const pk = periodKeyForEnd(line.periodEnd) ?? primaryPk;
    facts[`${line.metric}.${pk}`] = mkFact(line, pk);
    periodKeys.add(pk);
  }
  for (const pk of periodKeys) {
    resolveDerivedMetrics(facts, pk, allowed);
    runStructuralChecks(facts, pk);
  }
  return periodKeys;
}

function rawToR1Fact(raw: RawReportedFact): Fact {
  const hashInput = `${raw.sourceId}|${raw.locator}|${raw.snippet}|${raw.value}`;
  return {
    id: `${raw.metric}.${raw.period}`,
    metric: raw.metric,
    label: raw.label,
    period: raw.period,
    kind: raw.kind,
    value: raw.value,
    unit: raw.unit,
    rung: "R1",
    provenance: {
      sourceId: raw.sourceId,
      tag: raw.tag,
      documentName: raw.documentName,
      locator: raw.locator,
      snippet: raw.snippet,
      retrievedAt: raw.retrievedAt,
      contentHash: contentHash(hashInput),
    },
    verification: { status: "SINGLE_SOURCE", checks: [] },
  };
}

export function buildManifest(fixture: BorrowerFixture): FactManifest {
  const facts: Record<string, Fact> = {};

  // 1) Reported facts -> R1.
  for (const raw of fixture.reported) {
    const f = rawToR1Fact(raw);
    facts[f.id] = f;
  }

  // 2) Resolution ladder for each declared derived metric, per period.
  for (const period of fixture.periods) {
    resolveDerivedMetrics(facts, period.key, fixture.derivedMetrics);
  }

  // 3) Structural / cross-field checks, per period.
  for (const period of fixture.periods) {
    runStructuralChecks(facts, period.key);
  }

  const entity: EntityMeta = {
    companyName: fixture.displayName,
    companyNumber: fixture.profile.company_number,
    jurisdiction: fixture.profile.jurisdiction,
    status: fixture.profile.company_status,
    incorporatedOn: fixture.profile.date_of_creation,
    sicCodes: fixture.profile.sic_codes ?? [],
    registeredOffice: formatAddress(fixture),
    accountsType:
      fixture.profile.accounts?.last_accounts?.type === "full"
        ? "full"
        : fixture.profile.accounts?.last_accounts?.type === "micro-entity"
          ? "micro-entity"
          : "filleted",
    latestPeriodEnd: fixture.profile.accounts?.last_accounts?.made_up_to ?? "",
    synthetic: true,
  };

  const sources: Record<string, SourceDocument> = { ...fixture.sources };

  return { entity, facts, sources, generatedAt: fixture.reported[0]?.retrievedAt ?? "" };
}

function formatAddress(fixture: BorrowerFixture): string {
  const a = fixture.profile.registered_office_address;
  if (!a) return "";
  return [a.address_line_1, a.locality, a.postal_code, a.country]
    .filter(Boolean)
    .join(", ");
}
