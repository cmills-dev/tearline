// lib/kb/query.ts
// The fact / coverage query surface. Deterministic, pure reads over either a FactManifest
// or a TenantGraph (or a plain Fact array), so "what do we have, and how good is it?" has a
// single typed answer. Nothing here mutates; ordering is total and stable so the same input
// always yields the same output.

import type { Fact, Provenance, Rung } from "../engine/types";
import type { FactManifest } from "../engine/types";
import { TenantGraph } from "./graph";

// ---------------------------------------------------------------------------
// Provenance tier (P1 best .. P5 worst)
// ---------------------------------------------------------------------------
// A fact's rung says how it was resolved; its tier says how trustworthy the underlying
// SOURCE class is. We derive a P1-P5 tier from the ProvenanceTag (plus the "derived"
// sourceId sentinel), where P1 is the strongest source and P5 the weakest.
//
//   P1  Acc  filed statutory accounts (audited primary financial statements)
//   P2  Reg  Companies House structured public register (statutory, filer-independent)
//   P3  NF   network / filing history (charges register and similar structured secondaries)
//   P4  derived   an internally computed line (sourceId "derived"); no independent source
//   P5  Web  open web, and any fact with no provenance at all (R4 abstain)
//
// Rationale: accounts and the register are high (primary, statutory); a derived line and the
// filing-history network sit in the middle (structured but secondary or self-referential);
// open web is lowest. This mapping is documented so downstream sorting is auditable.

export type Tier = "P1" | "P2" | "P3" | "P4" | "P5";

const TIER_RANK: Record<Tier, number> = { P1: 1, P2: 2, P3: 3, P4: 4, P5: 5 };

export function provenanceTier(provenance: Provenance | null | undefined): Tier {
  if (!provenance) return "P5";
  if (provenance.sourceId === "derived") return "P4";
  switch (provenance.tag) {
    case "Acc":
      return "P1";
    case "Reg":
      return "P2";
    case "NF":
      return "P3";
    case "Web":
      return "P5";
    default:
      return "P5";
  }
}

export function factTier(fact: Fact): Tier {
  return provenanceTier(fact.provenance);
}

// ---------------------------------------------------------------------------
// Rung ordering (R1 best)
// ---------------------------------------------------------------------------

const RUNG_RANK: Record<Rung, number> = { R1: 1, R2: 2, R3: 3, R4: 4 };

export function rungRank(rung: Rung): number {
  return RUNG_RANK[rung];
}

// A fact is "resolved" when the ladder produced a defensible value (R1-R3, non-null). R4 is
// an honest abstain.
export function isResolved(fact: Fact): boolean {
  return fact.rung !== "R4" && fact.value !== null;
}

// ---------------------------------------------------------------------------
// Period recency
// ---------------------------------------------------------------------------
// Periods are keys such as "FY2024" or "As at 31 Dec 2024" or "LATEST". We extract a sortable
// year; a higher number is more recent. "LATEST" (a live record with no dated accounts) sorts
// ahead of any dated period.

export function periodRecencyKey(period: string): number {
  if (/latest/i.test(period)) return 9999;
  const m = period.match(/(\d{4})/);
  return m ? Number(m[1]) : 0;
}

// ---------------------------------------------------------------------------
// Sources of facts
// ---------------------------------------------------------------------------

export type QuerySource = FactManifest | TenantGraph | Fact[];

function isManifest(x: QuerySource): x is FactManifest {
  return !Array.isArray(x) && !(x instanceof TenantGraph) && "facts" in x && "entity" in x;
}

// Resolve a query source to a flat Fact array, honouring an optional entity filter. For a
// manifest, the entity filter matches its single entity by company number or name (returns
// [] if it does not match, which is the honest answer). For a graph, it filters fact nodes by
// company number. For a plain array, the caller has already scoped it, so entity is ignored.
function factsFromSource(source: QuerySource, entity?: string): Fact[] {
  if (Array.isArray(source)) return source;
  if (source instanceof TenantGraph) {
    if (!entity) return source.facts();
    // Match a graph entity by company number first, then by name.
    const byNumber = source.facts(entity);
    if (byNumber.length > 0) return byNumber;
    const named = source.entities().find((e) => e.companyName === entity);
    return named ? source.facts(named.companyNumber) : [];
  }
  if (isManifest(source)) {
    if (entity && source.entity.companyNumber !== entity && source.entity.companyName !== entity) {
      return [];
    }
    return Object.values(source.facts);
  }
  return [];
}

// ---------------------------------------------------------------------------
// factsFor
// ---------------------------------------------------------------------------

export interface FactQuery {
  entity: string; // company number or name
  metric?: string; // exact metric key, e.g. "netDebt"
  period?: string; // exact period key, e.g. "FY2024"
  minRung?: Rung; // include facts at this rung or better (R1 best); e.g. minRung "R3" excludes R4
}

// Return every fact matching the query, in a stable order (best rung first, then best tier,
// then fact id). Pure.
export function factsFor(source: QuerySource, q: FactQuery): Fact[] {
  const pool = factsFromSource(source, q.entity);
  const maxRank = q.minRung ? rungRank(q.minRung) : Infinity;
  const matched = pool.filter((f) => {
    if (q.metric && f.metric !== q.metric) return false;
    if (q.period && f.period !== q.period) return false;
    if (rungRank(f.rung) > maxRank) return false;
    return true;
  });
  return sortFacts(matched, "rung");
}

// ---------------------------------------------------------------------------
// sortFacts
// ---------------------------------------------------------------------------

export type SortKey = "rung" | "recency" | "tier";

// Order a fact list by the requested primary key, with a fixed tie-break chain so the result
// is deterministic. Returns a new array; the input is not mutated.
//   rung     R1 before R4 (best resolution first)
//   recency  most recent period first
//   tier     P1 before P5 (best source first)
export function sortFacts(facts: Fact[], by: SortKey): Fact[] {
  const byRung = (f: Fact) => rungRank(f.rung);
  const byRecency = (f: Fact) => -periodRecencyKey(f.period); // negate so recent sorts first
  const byTier = (f: Fact) => TIER_RANK[factTier(f)];

  // The requested key leads; the other two plus the fact id form a fixed tie-break chain, so
  // the ordering is total and deterministic.
  const chain: Array<(f: Fact) => number> =
    by === "rung"
      ? [byRung, byTier, byRecency]
      : by === "recency"
        ? [byRecency, byRung, byTier]
        : [byTier, byRung, byRecency];

  return [...facts].sort((a, b) => {
    for (const key of chain) {
      const ka = key(a);
      const kb = key(b);
      if (ka < kb) return -1;
      if (ka > kb) return 1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// ---------------------------------------------------------------------------
// coverage
// ---------------------------------------------------------------------------
// For a required metric set at a period, how much do we actually hold? Every required metric
// lands in exactly one bucket:
//   resolved   a fact exists at R1-R3 with a value
//   abstained  a fact exists but abstains at R4
//   missing    no fact exists at all for that metric+period
// The coverage ratio is resolved / required.

export interface CoverageReport {
  entity: string;
  period: string;
  required: string[];
  resolved: string[];
  abstained: string[];
  missing: string[];
  counts: { resolved: number; abstained: number; missing: number; required: number };
  ratio: number; // resolved / required, 0 when nothing is required
}

export interface CoverageQuery {
  entity: string;
  period: string;
  required: string[];
}

export function coverage(source: QuerySource, q: CoverageQuery): CoverageReport {
  const pool = factsFromSource(source, q.entity).filter((f) => f.period === q.period);
  const byMetric = new Map<string, Fact>();
  for (const f of pool) byMetric.set(f.metric, f);

  const resolved: string[] = [];
  const abstained: string[] = [];
  const missing: string[] = [];

  for (const metric of q.required) {
    const f = byMetric.get(metric);
    if (!f) missing.push(metric);
    else if (isResolved(f)) resolved.push(metric);
    else abstained.push(metric);
  }

  const required = q.required.length;
  return {
    entity: q.entity,
    period: q.period,
    required: q.required,
    resolved,
    abstained,
    missing,
    counts: {
      resolved: resolved.length,
      abstained: abstained.length,
      missing: missing.length,
      required,
    },
    ratio: required === 0 ? 0 : resolved.length / required,
  };
}
