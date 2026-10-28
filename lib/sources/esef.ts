// lib/sources/esef.ts
// ESEF / UKSEF deterministic path for EU and UK-listed groups. The same issuer that lodges
// a scanned PDF at Companies House files clean, fully-tagged iXBRL for its IFRS consolidated
// statements with the regulator; filings.xbrl.org publishes those as pre-computed xBRL-JSON
// (free, no key). We keep only the CONSOLIDATED totals (facts carrying no company-extension
// or segment dimension) and only ifrs-full concepts (abstain on extension namespaces), map
// them into the same FactManifest, and let the shared ladder + verify run unchanged. Keyed
// by LEI (resolved via GLEIF), so it composes with the entity resolver.

import type { Fact, FactManifest, FactPrecision, Provenance, EntityMeta, SourceDocument } from "../engine/types";
import { addPrecision, precisionFromDecimals } from "../engine/precision";
import type { ExtractedLine } from "./ixbrl";
import type { BorrowerFixture, PeriodMeta, CapitalTranche } from "./fixtures/types";
import type { CompanyProfile } from "./companiesHouse";
import { contentHash } from "../engine/hash";
import { assembleTearSheet, type TearSheet } from "../engine/assemble";
import { landFinancialLines } from "../engine/buildManifest";
import { getCache } from "../cache/cache";
import { fetchTextLimited, MB } from "./fetchLimits";
import { resolveLei } from "./gleif";

const BASE = "https://filings.xbrl.org";
const SOURCE = "esef-xbrl";
const CORE_DIMS = new Set(["concept", "entity", "period", "unit", "language"]);

function today() {
  return new Date().toISOString().slice(0, 10);
}

// ifrs-full concept local names (lowercased) -> our base metrics.
const CONCEPTS: Record<string, string[]> = {
  turnover: ["revenue"],
  operatingProfit: ["profitlossfromoperatingactivities"],
  depreciationAmortisation: [
    "depreciationandamortisationexpense",
    "depreciationamortisationandimpairmentlossreversalofimpairmentlossrecognisedinprofitorloss",
  ],
  cash: ["cashandcashequivalents"],
  netInterest: ["financecosts"],
};
const LONG_BORROW = ["longtermborrowings", "noncurrentborrowings"];
const SHORT_BORROW = ["shorttermborrowings", "currentborrowings"];
const COMBINED_BORROW = ["borrowings"];
const LABELS: Record<string, string> = {
  turnover: "Revenue",
  operatingProfit: "Operating profit",
  depreciationAmortisation: "Depreciation and amortisation",
  cash: "Cash and cash equivalents",
  netInterest: "Finance costs",
  borrowings: "Total borrowings",
};

interface EsefFact {
  value: unknown;
  decimals?: unknown;
  dimensions?: Record<string, string>;
}
export interface EsefDoc {
  facts?: Record<string, EsefFact>;
}

function endOfPeriod(p: string | undefined): string {
  if (!p) return "";
  const part = p.includes("/") ? p.split("/")[1] : p;
  return part.slice(0, 10);
}

// The reporting currency of a fact, read from its `unit` dimension (xBRL-JSON tags monetary
// facts with e.g. "iso4217:EUR"). Returns the ISO 4217 code, or "GBP" only when no unit is
// present. This is what stops a EUR or USD issuer's figures being rendered as sterling.
function unitCurrency(dim: Record<string, string | undefined>): string {
  const u = typeof dim.unit === "string" ? dim.unit : "";
  const code = u.split(":").pop()?.toUpperCase() ?? "";
  return code || "GBP";
}

// The consolidated total for a concept: facts carrying ONLY the core dimensions (no
// segment / adjusting-items / company-extension member), on the latest period. Returns null
// when absent or ambiguous (two core-dimension totals with different values -> abstain). Carries
// the fact's reporting currency so the tear sheet never mislabels a non-GBP figure.
type EsefHit = { value: number; periodEnd: string; unit: string; precision?: FactPrecision };

function pickTotal(doc: EsefDoc, concepts: string[]): EsefHit | null {
  const wanted = new Set(concepts);
  const cands: { value: number; end: string; unit: string; precision?: FactPrecision }[] = [];
  for (const f of Object.values(doc.facts ?? {})) {
    const dim = (f.dimensions ?? {}) as Record<string, string | undefined>;
    const c = (dim.concept ?? "").toLowerCase();
    if (!c.startsWith("ifrs-full:")) continue;
    if (!wanted.has(c.split(":", 1 + 1)[1])) continue;
    if (Object.keys(dim).some((k) => !CORE_DIMS.has(k))) continue; // consolidated total only
    const value = typeof f.value === "number" ? f.value : parseFloat(String(f.value));
    if (!isFinite(value)) continue;
    // xBRL-JSON carries the filer's decimals. Its value string is not the printed figure
    // ("72886000000.0"), so without decimals the precision is left unknown and the flat tolerance applies.
    const precision = precisionFromDecimals(f.decimals);
    cands.push({ value, end: endOfPeriod(dim.period), unit: unitCurrency(dim), precision });
  }
  if (cands.length === 0) return null;
  cands.sort((a, b) => (a.end < b.end ? 1 : a.end > b.end ? -1 : 0));
  const latestEnd = cands[0].end;
  const onLatest = cands.filter((c) => c.end === latestEnd);
  const distinct = new Set(onLatest.map((c) => c.value));
  if (distinct.size > 1) return null; // ambiguous -> abstain
  return { value: onLatest[0].value, periodEnd: latestEnd, unit: onLatest[0].unit, precision: onLatest[0].precision };
}

export function extractEsefFinancials(doc: EsefDoc): { periodEnd: string; lines: ExtractedLine[] } | null {
  const lines: ExtractedLine[] = [];
  const add = (metric: string, concept: string, hit: EsefHit | null) => {
    if (!hit) return;
    lines.push({
      metric,
      label: LABELS[metric] ?? metric,
      unit: hit.unit,
      value: hit.value,
      concept: `ifrs-full:${concept}`,
      contextRef: "",
      periodEnd: hit.periodEnd,
      rawText: String(hit.value),
      precision: hit.precision,
    });
  };

  for (const metric of Object.keys(CONCEPTS)) {
    add(metric, CONCEPTS[metric][0], pickTotal(doc, CONCEPTS[metric]));
  }
  // Borrowings: combined tag, else long-term + short-term. Long- and short-term are picked
  // independently and can land in different periods; the short-term component is added only
  // when it shares the long-term component's period end, so borrowings is never summed across
  // two fiscal years. When they mismatch, the anchor component alone is reported for its year.
  const combined = pickTotal(doc, COMBINED_BORROW);
  if (combined) {
    add("borrowings", "Borrowings", combined);
  } else {
    const lt = pickTotal(doc, LONG_BORROW);
    const st = pickTotal(doc, SHORT_BORROW);
    if (lt || st) {
      const primary = lt ?? st!;
      const secondary = lt && st && st.periodEnd === lt.periodEnd ? st : null;
      const value = primary.value + (secondary ? secondary.value : 0);
      const concept = secondary
        ? "ifrs-full:LongtermBorrowings + ifrs-full:ShorttermBorrowings"
        : lt
          ? "ifrs-full:LongtermBorrowings"
          : "ifrs-full:ShorttermBorrowings";
      lines.push({
        metric: "borrowings",
        label: LABELS.borrowings,
        unit: primary.unit,
        value,
        concept,
        contextRef: "",
        periodEnd: primary.periodEnd,
        rawText: String(value),
        precision: secondary ? addPrecision(primary.precision, secondary.precision) : primary.precision,
      });
    }
  }

  if (lines.length === 0) return null;
  const periodEnd = lines.map((l) => l.periodEnd).filter(Boolean).sort().reverse()[0] ?? "";
  return { periodEnd, lines };
}

// ---------------------------------------------------------------------------
// Manifest mapping (pure)
// ---------------------------------------------------------------------------
function periodMeta(periodEnd: string): PeriodMeta {
  return { key: `FY${periodEnd.slice(0, 4)}`, label: `Year ended ${periodEnd}`, end: periodEnd, isLatest: true };
}
function esefProvenance(line: ExtractedLine, lei: string, fxoId: string): Provenance {
  return {
    sourceId: SOURCE,
    tag: "Acc",
    documentName: "Annual report (ESEF/UKSEF iXBRL, filings.xbrl.org)",
    locator: `https://filings.xbrl.org/${encodeURIComponent(fxoId)}`,
    snippet: `${line.concept} = ${line.rawText} (period end ${line.periodEnd}, LEI ${lei})`,
    retrievedAt: today(),
    contentHash: contentHash(`${SOURCE}|${line.concept}|${line.value}|${line.periodEnd}`),
  };
}
function reportedFact(line: ExtractedLine, period: string, lei: string, fxoId: string): Fact {
  return {
    id: `${line.metric}.${period}`,
    metric: line.metric,
    label: line.label,
    period,
    kind: "currency",
    value: line.value,
    unit: line.unit || "GBP",
    rung: "R1",
    provenance: esefProvenance(line, lei, fxoId),
    verification: { status: "SINGLE_SOURCE", checks: [] },
    ...(line.precision ? { precision: line.precision } : {}),
  };
}

export function mapEsefToManifest(lei: string, name: string, fxoId: string, doc: EsefDoc): FactManifest | null {
  const fin = extractEsefFinancials(doc);
  if (!fin) return null;
  const pk = periodMeta(fin.periodEnd).key;
  const facts: Record<string, Fact> = {};
  // Each line lands under its own fiscal year, so leverage / cover only combine same-year facts.
  landFinancialLines(facts, fin.lines, pk, (line, periodKey) => reportedFact(line, periodKey, lei, fxoId));

  const entity: EntityMeta = {
    companyName: name,
    companyNumber: `LEI ${lei}`,
    jurisdiction: "EU/UK listed (ESEF)",
    status: "Listed issuer",
    incorporatedOn: "",
    sicCodes: [],
    registeredOffice: "",
    accountsType: "full",
    latestPeriodEnd: fin.periodEnd,
    synthetic: false,
    lei,
  };
  const sources: Record<string, SourceDocument> = {
    [SOURCE]: {
      sourceId: SOURCE,
      tag: "Acc",
      documentName: "ESEF/UKSEF iXBRL consolidated statements (filings.xbrl.org)",
      retrievedAt: today(),
      origin: `https://filings.xbrl.org/${encodeURIComponent(fxoId)}`,
    },
  };
  return { entity, facts, sources, generatedAt: today() };
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------
interface FilingsList {
  data?: { attributes?: { fxo_id?: string; json_url?: string; country?: string } }[];
}

// ESEF facts JSON can run to 100MB+ for a large group; cap generously above that so real filings
// are never trimmed, while a pathological/oversize body cannot be buffered whole (OOM/DoS guard).
// A timeout bounds a slow upstream. On any failure (incl. oversize / timeout) we return null so the
// caller abstains, exactly as before, never a wrong number.
const ESEF_MAX_BYTES = 256 * MB;
const ESEF_TIMEOUT_MS = 45_000;

async function jget<T>(url: string, cacheKey: string, accept: string): Promise<T | null> {
  const cache = getCache();
  const cached = await cache.get<T>(cacheKey);
  if (cached) return cached;
  try {
    const res = await fetchTextLimited(url, { accept, maxBytes: ESEF_MAX_BYTES, timeoutMs: ESEF_TIMEOUT_MS });
    if (!res.ok) return null;
    const data = JSON.parse(res.text) as T;
    await cache.set(cacheKey, data, 60 * 60 * 24);
    return data;
  } catch {
    return null;
  }
}

export async function latestEsefFiling(lei: string): Promise<{ fxoId: string; doc: EsefDoc } | null> {
  // The JSON:API index needs application/vnd.api+json; the facts file is a plain JSON
  // document and 406s on the vnd.api+json Accept, so it is fetched as application/json.
  const list = await jget<FilingsList>(
    `${BASE}/api/entities/${lei}/filings?sort=-date_added&page%5Bsize%5D=1`,
    `esef:filings:${lei}`,
    "application/vnd.api+json",
  );
  const a = list?.data?.[0]?.attributes;
  if (!a?.json_url) return null;
  // Key the doc cache on the fxo_id when present, else the ALWAYS-present json_url. Keying on a
  // possibly-absent fxo_id alone collapsed every fxo_id-less filing onto `esef:doc:undefined`,
  // so one issuer's facts could be served for another. json_url is unique per filing.
  const doc = await jget<EsefDoc>(`${BASE}${a.json_url}`, `esef:doc:${a.fxo_id ?? a.json_url}`, "application/json");
  if (!doc) return null;
  return { fxoId: a.fxo_id ?? a.json_url, doc };
}

function esefFixture(entity: EntityMeta, manifest: FactManifest): BorrowerFixture {
  const pk = `FY${entity.latestPeriodEnd.slice(0, 4)}`;
  const hasDebt = !!manifest.facts[`borrowings.${pk}`]?.value;
  const cap: CapitalTranche[] = hasDebt
    ? [{ id: "total-debt", name: "Total borrowings (per balance sheet)", rank: "not-stated", metric: "borrowings", security: "Consolidated borrowings tagged in the ESEF report", provider: "Various", isFulcrum: false }]
    : [];
  const profile = {
    company_name: entity.companyName,
    company_number: entity.companyNumber,
    company_status: "listed",
    date_of_creation: "",
    type: "listed",
    jurisdiction: "esef",
  } as CompanyProfile;
  return {
    key: entity.lei ?? entity.companyNumber,
    displayName: entity.companyName,
    thesis:
      "Live ESEF/UKSEF filing. The IFRS consolidated statements are tagged in iXBRL, so revenue, operating profit, cash and borrowings resolve at R1 and the ladder synthesises EBITDA, net debt and leverage. No document parsing, no model, no fabrication.",
    profile,
    filingHistory: { items: [], total_count: 0 },
    charges: { items: [], total_count: 0 },
    sources: manifest.sources,
    periods: [periodMeta(entity.latestPeriodEnd)],
    reported: [],
    capitalStructure: cap,
    derivedMetrics: [],
  };
}

// Assemble the tear sheet AND return the underlying manifest, so the /esef route can
// persist the FactManifest to the tenant workspace as a side effect of rendering.
export async function assembleEsef(
  query: string,
): Promise<{ ts: TearSheet; manifest: FactManifest } | null> {
  const lei = await resolveLei(query, { country: query.length === 20 ? undefined : "GB" });
  const leiCode = /^[A-Z0-9]{20}$/.test(query) ? query : lei?.lei;
  if (!leiCode) return null;
  const filing = await latestEsefFiling(leiCode);
  if (!filing) return null;
  const manifest = mapEsefToManifest(leiCode, lei?.legalName ?? query, filing.fxoId, filing.doc);
  if (!manifest) return null;
  return { ts: assembleTearSheet(manifest, esefFixture(manifest.entity, manifest)), manifest };
}

export async function assembleEsefTearSheet(query: string): Promise<TearSheet | null> {
  const r = await assembleEsef(query);
  return r?.ts ?? null;
}
