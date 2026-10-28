// lib/sources/secEdgar.ts
// SEC EDGAR structured source. US filers tag their financial statements in full, so
// data.sec.gov hands back the income statement, balance sheet and cash flow already
// machine-readable: no PDF parsing, no model, no fabrication risk. This adapter maps
// the SEC "Company Facts" XBRL into the same FactManifest the rest of the engine
// consumes, so a US name flows through the identical resolution ladder, verification
// and EvidenceCards as everything else. See docs/extraction-strategy.md (US is the
// solved, highest-ROI jurisdiction).
//
// No key is required. The SEC asks only for a descriptive User-Agent (a contact), set
// SEC_USER_AGENT to your own; the default is a generic identifier. Rate limit is 10
// requests/sec/IP; we cache aggressively and make few calls per name.

import type { Fact, FactManifest, Provenance, EntityMeta, SourceDocument } from "../engine/types";
import type { ExtractedLine } from "./ixbrl";
import type { BorrowerFixture, PeriodMeta, CapitalTranche } from "./fixtures/types";
import type { CompanyProfile } from "./companiesHouse";
import { contentHash } from "../engine/hash";
import { addPrecision, precisionFromValue } from "../engine/precision";
import { assembleTearSheet, type TearSheet } from "../engine/assemble";
import { landFinancialLines } from "../engine/buildManifest";
import { getCache } from "../cache/cache";
import { fetchTextLimited, MB } from "./fetchLimits";

// The SEC asks for a descriptive User-Agent with a contact. Override with your own via
// SEC_USER_AGENT; the default carries a contact token so requests are accepted.
const EDGAR_UA = process.env.SEC_USER_AGENT || "Origination credit-intelligence research@origination.app";
const DATA_BASE = "https://data.sec.gov";
const FACTS_SOURCE = "sec-edgar-companyfacts";
const REG_SOURCE = "sec-edgar-submissions";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
function cikPad(cik: string | number): string {
  return String(cik).replace(/\D/g, "").padStart(10, "0");
}

// ---------------------------------------------------------------------------
// SEC JSON shapes (only the fields we read)
// ---------------------------------------------------------------------------
interface EdgarUnitFact {
  end: string; // period end (instant, or duration end)
  val: number;
  fy?: number;
  fp?: string; // "FY", "Q1"...
  form?: string; // "10-K", "10-Q"...
  accn?: string; // accession, e.g. "0000320193-24-000123"
  filed?: string; // the FILING (as-reported) date, YYYY-MM-DD - drives KB restatement precedence
  start?: string;
}
interface EdgarConcept {
  label?: string;
  units: Record<string, EdgarUnitFact[]>;
}
export interface CompanyFacts {
  cik: number;
  entityName: string;
  facts: { "us-gaap"?: Record<string, EdgarConcept>; dei?: Record<string, EdgarConcept> };
}
export interface Submissions {
  cik: string;
  name: string;
  sicDescription?: string;
  sic?: string;
  stateOfIncorporation?: string;
  fiscalYearEnd?: string; // "MMDD"
  tickers?: string[];
}

// ---------------------------------------------------------------------------
// Concept mapping: US-GAAP concept local names -> our base metric keys. The ladder
// (resolveDerivedMetrics) synthesises EBITDA, net debt, leverage and cover from these,
// exactly as it does for a UK iXBRL name or a fixture. Ordered by preference; the first
// concept that yields an annual USD value wins.
// ---------------------------------------------------------------------------
const CONCEPTS: Record<string, string[]> = {
  turnover: [
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "Revenues",
    "SalesRevenueNet",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
  ],
  operatingProfit: ["OperatingIncomeLoss"],
  depreciationAmortisation: [
    "DepreciationDepletionAndAmortization",
    "DepreciationAmortizationAndAccretionNet",
    "DepreciationAndAmortization",
  ],
  cash: [
    "CashAndCashEquivalentsAtCarryingValue",
    "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
  ],
  netInterest: ["InterestExpense", "InterestExpenseNonoperating"],
};
const LABELS: Record<string, string> = {
  turnover: "Turnover (revenue)",
  operatingProfit: "Operating profit",
  depreciationAmortisation: "Depreciation and amortisation",
  cash: "Cash and cash equivalents",
  netInterest: "Interest expense",
  borrowings: "Total debt",
};

// The latest ANNUAL fact for a concept: form 10-K, full-year period (fp FY), USD, most
// recent end date. Restricting to 10-K/FY avoids picking a quarter or a comparative.
function latestAnnual(concept: EdgarConcept | undefined): EdgarUnitFact | null {
  const usd = concept?.units?.["USD"];
  if (!usd?.length) return null;
  const annual = usd.filter((f) => f.form === "10-K" && f.fp === "FY");
  const pool = annual.length ? annual : usd.filter((f) => f.form === "10-K");
  if (!pool.length) return null;
  return pool.reduce((a, b) => (a.end >= b.end ? a : b));
}

function pick(cf: CompanyFacts, concepts: string[]): { concept: string; fact: EdgarUnitFact } | null {
  const gaap = cf.facts["us-gaap"] || {};
  for (const name of concepts) {
    const f = latestAnnual(gaap[name]);
    if (f) return { concept: name, fact: f };
  }
  return null;
}

// Extract the base financial lines from Company Facts, in the ExtractedLine shape the
// rest of the engine already understands. Borrowings is summed from long-term + current
// debt when a single combined tag is absent. Anything untagged is simply omitted, and
// the ladder abstains on the derived metric rather than inventing one.
export function extractEdgarFinancials(cf: CompanyFacts): { periodEnd: string; lines: ExtractedLine[] } | null {
  const gaap = cf.facts["us-gaap"] || {};
  const lines: ExtractedLine[] = [];
  const mkLine = (metric: string, concept: string, f: EdgarUnitFact): ExtractedLine => ({
    metric,
    label: LABELS[metric] ?? metric,
    unit: "USD",
    value: f.val,
    concept: `us-gaap:${concept}`,
    contextRef: f.accn ?? "",
    periodEnd: f.end,
    rawText: String(f.val),
    filedAt: f.filed, // the as-reported date, for KB restatement precedence
    // Company Facts carries no decimals and no printed figure, so the precision is inferred from
    // the value, and verify.ts never lets that loosen a check beyond the flat 0.5%.
    precision: precisionFromValue(f.val),
  });

  for (const metric of Object.keys(CONCEPTS)) {
    const hit = pick(cf, CONCEPTS[metric]);
    if (hit) lines.push(mkLine(metric, hit.concept, hit.fact));
  }

  // Borrowings: prefer a combined tag, else long-term (+ current) debt. The current-debt
  // component is only added when it shares the long-term component's period end: each is
  // picked as its own latest annual fact, so they can fall in different fiscal years, and
  // summing across years would report a debt figure that never existed on one balance sheet.
  const combined = pick(cf, ["DebtLongtermAndShorttermCombinedAmount"]);
  if (combined) {
    lines.push(mkLine("borrowings", combined.concept, combined.fact));
  } else {
    const lt = pick(cf, ["LongTermDebtNoncurrent", "LongTermDebt"]);
    const cur = pick(cf, ["LongTermDebtCurrent", "DebtCurrent"]);
    if (lt) {
      const sameCur = cur && cur.fact.end === lt.fact.end ? cur : null;
      const val = lt.fact.val + (sameCur ? sameCur.fact.val : 0);
      const concept = sameCur ? `${lt.concept}+${sameCur.concept}` : lt.concept;
      const line = mkLine("borrowings", concept, { ...lt.fact, val });
      if (sameCur) line.precision = addPrecision(precisionFromValue(lt.fact.val), precisionFromValue(sameCur.fact.val));
      lines.push(line);
    }
  }

  if (!lines.length) return null;
  // Primary period = the latest end date among the duration lines (fall back to any).
  const periodEnd = lines.map((l) => l.periodEnd).sort().slice(-1)[0];
  return { periodEnd, lines };
}

// ---------------------------------------------------------------------------
// Fact builders
// ---------------------------------------------------------------------------
function periodMeta(periodEnd: string): PeriodMeta {
  const year = periodEnd.slice(0, 4);
  return {
    key: `FY${year}`,
    label: `Year ended ${periodEnd}`,
    end: periodEnd,
    isLatest: true,
  };
}

function financialProvenance(line: ExtractedLine, cik: string): Provenance {
  const accn = line.contextRef;
  const filingUrl = accn && /^\d{10}-\d{2}-\d{6}$/.test(accn)
    ? `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accn.replace(/-/g, "")}/${accn}-index.htm`
    : `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=10-K`;
  return {
    sourceId: FACTS_SOURCE,
    tag: "Acc",
    documentName: "Annual report (Form 10-K, SEC XBRL)",
    locator: filingUrl,
    snippet: `${line.concept} = ${line.rawText} USD (FY end ${line.periodEnd}, form 10-K${accn ? `, accession ${accn}` : ""})`,
    retrievedAt: today(),
    contentHash: contentHash(`${FACTS_SOURCE}|${line.concept}|${line.value}|${line.periodEnd}`),
  };
}

function reportedFinancialFact(line: ExtractedLine, period: string, cik: string): Fact {
  return {
    id: `${line.metric}.${period}`,
    metric: line.metric,
    label: line.label,
    period,
    kind: "currency",
    value: line.value,
    unit: line.unit || "USD",
    rung: "R1",
    provenance: financialProvenance(line, cik),
    verification: { status: "SINGLE_SOURCE", checks: [] },
    ...(line.precision ? { precision: line.precision } : {}),
  };
}

function structuredFact(
  metric: string,
  label: string,
  period: string,
  value: string,
  cik: string,
  origin: string,
): Fact {
  return {
    id: `${metric}.${period}`,
    metric,
    label,
    period,
    kind: "text",
    value,
    unit: "",
    rung: "R1",
    provenance: {
      sourceId: REG_SOURCE,
      tag: "Reg",
      documentName: "SEC EDGAR submissions (structured record)",
      locator: origin,
      snippet: value,
      retrievedAt: today(),
      contentHash: contentHash(`${REG_SOURCE}|${metric}|${value}|${cik}`),
    },
    verification: { status: "SINGLE_SOURCE", checks: [] },
  };
}

// ---------------------------------------------------------------------------
// Manifest mapping (pure: takes already-fetched JSON)
// ---------------------------------------------------------------------------
export function mapEdgarToManifest(sub: Submissions, cf: CompanyFacts): FactManifest {
  const cik = cikPad(sub.cik ?? cf.cik);
  const origin = `${DATA_BASE}/submissions/CIK${cik}.json`;
  const fin = extractEdgarFinancials(cf);
  const pk = (fin ? periodMeta(fin.periodEnd) : periodMeta(`${new Date().getFullYear() - 1}-12-31`)).key;
  const facts: Record<string, Fact> = {};

  if (sub.sicDescription || sub.sic) {
    facts[`sector.${pk}`] = structuredFact(
      "sector",
      "Industry (SIC)",
      pk,
      `${sub.sicDescription ?? "Industry"}${sub.sic ? ` (SIC ${sub.sic})` : ""}`,
      cik,
      origin,
    );
  }
  if (sub.stateOfIncorporation) {
    facts[`incorporation.${pk}`] = structuredFact(
      "incorporation",
      "State of incorporation",
      pk,
      sub.stateOfIncorporation,
      cik,
      origin,
    );
  }
  facts[`accountsReference.${pk}`] = structuredFact(
    "accountsReference",
    "Filing",
    pk,
    `Latest annual report (Form 10-K)${fin ? `, period end ${fin.periodEnd}` : ""}`,
    cik,
    origin,
  );

  if (fin) {
    // Each line lands under its OWN fiscal year, never a single latest key, so leverage / cover
    // are only ever computed from same-year base facts (see landFinancialLines).
    landFinancialLines(facts, fin.lines, pk, (line, periodKey) => reportedFinancialFact(line, periodKey, cik));
  }

  // The as-reported date: the latest FILING date among the primary-period lines. A 10-K/A that
  // restates the same period carries a later `filed` than the original 10-K, so this makes the
  // amendment supersede its original in the KB, while a mere re-fetch of the original does not.
  const primaryYear = (fin?.periodEnd ?? "").slice(0, 4);
  const asReportedAt = fin
    ? fin.lines
        .filter((l) => l.periodEnd.slice(0, 4) === primaryYear && l.filedAt)
        .map((l) => l.filedAt as string)
        .sort()
        .slice(-1)[0]
    : undefined;

  const entity: EntityMeta = {
    companyName: sub.name ?? cf.entityName,
    companyNumber: `CIK ${cik}`,
    jurisdiction: sub.stateOfIncorporation ? `US (${sub.stateOfIncorporation})` : "United States",
    status: "SEC registrant",
    incorporatedOn: "",
    sicCodes: sub.sic ? [sub.sic] : [],
    registeredOffice: "United States",
    accountsType: "full",
    latestPeriodEnd: fin?.periodEnd ?? "",
    asReportedAt,
    synthetic: false,
  };

  const sources: Record<string, SourceDocument> = {
    [REG_SOURCE]: {
      sourceId: REG_SOURCE,
      tag: "Reg",
      documentName: "SEC EDGAR submissions (structured record)",
      retrievedAt: today(),
      origin,
    },
  };
  if (fin) {
    sources[FACTS_SOURCE] = {
      sourceId: FACTS_SOURCE,
      tag: "Acc",
      documentName: "SEC Company Facts (XBRL, Form 10-K)",
      retrievedAt: today(),
      origin: `${DATA_BASE}/api/xbrl/companyfacts/CIK${cik}.json`,
    };
  }

  return { entity, facts, sources, generatedAt: today() };
}

const EDGAR_THESIS =
  "Live SEC EDGAR record. US filers tag their financial statements in full, so turnover, operating profit, depreciation, cash and debt resolve at R1 from the Company Facts XBRL, and the ladder synthesises EBITDA, net debt and leverage. No document parsing and no model, so no figure is fabricated.";

// Minimal fixture so an EDGAR manifest renders through the shared assemble pipeline.
// assembleTearSheet reads only periods, thesis and capitalStructure off the fixture.
function mapEdgarToFixture(sub: Submissions, cf: CompanyFacts, manifest: FactManifest): BorrowerFixture {
  const fin = extractEdgarFinancials(cf);
  const period = fin ? periodMeta(fin.periodEnd) : periodMeta(`${new Date().getFullYear() - 1}-12-31`);
  const cik = cikPad(sub.cik ?? cf.cik);
  const hasDebt = !!manifest.facts[`borrowings.${period.key}`]?.value;
  const capitalStructure: CapitalTranche[] = hasDebt
    ? [
        {
          id: "total-debt",
          name: "Total debt (per balance sheet)",
          // A balance sheet total states no ranking and no fulcrum (audit finding 7).
          rank: "not-stated",
          metric: "borrowings",
          security: "Consolidated debt as tagged in the Form 10-K",
          provider: "Various",
          isFulcrum: false,
        },
      ]
    : [];
  const profile: CompanyProfile = {
    company_name: sub.name ?? cf.entityName,
    company_number: `CIK ${cik}`,
    company_status: "SEC registrant",
    date_of_creation: "",
    type: "sec-registrant",
    jurisdiction: "united-states",
    sic_codes: sub.sic ? [sub.sic] : [],
  };
  return {
    key: cik,
    displayName: sub.name ?? cf.entityName,
    thesis: EDGAR_THESIS,
    profile,
    filingHistory: { items: [], total_count: 0 },
    charges: { items: [], total_count: 0 },
    sources: manifest.sources,
    periods: [period],
    reported: [],
    capitalStructure,
    derivedMetrics: [],
  };
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------
// SEC companyfacts JSON runs to tens of MB for a large filer; cap well above that so real data is
// never trimmed, but a pathological/oversize response cannot be buffered whole (OOM/DoS guard).
const EDGAR_MAX_BYTES = 96 * MB;
const EDGAR_TIMEOUT_MS = 30_000;

async function edgarGet<T>(url: string, cacheKey: string, ttl: number): Promise<T> {
  const cache = getCache();
  const cached = await cache.get<T>(cacheKey);
  if (cached) return cached;
  const res = await fetchTextLimited(url, {
    headers: { "User-Agent": EDGAR_UA },
    accept: "application/json",
    maxBytes: EDGAR_MAX_BYTES,
    timeoutMs: EDGAR_TIMEOUT_MS,
  });
  if (!res.ok) throw new Error(`SEC EDGAR ${res.status} for ${url}`);
  const data = JSON.parse(res.text) as T;
  await cache.set(cacheKey, data, ttl);
  return data;
}

// ticker or name -> CIK, via the SEC ticker map. Also accepts a raw CIK.
export async function resolveCik(query: string): Promise<{ cik: string; name: string; ticker?: string } | null> {
  const q = query.trim();
  if (/^\d{1,10}$/.test(q)) return { cik: cikPad(q), name: "" };
  const map = await edgarGet<Record<string, { cik_str: number; ticker: string; title: string }>>(
    "https://www.sec.gov/files/company_tickers.json",
    "sec:company_tickers",
    60 * 60 * 24,
  );
  const rows = Object.values(map);
  const upper = q.toUpperCase();
  const exact = rows.find((r) => r.ticker.toUpperCase() === upper);
  const byName =
    exact ??
    rows.find((r) => r.title.toUpperCase() === upper) ??
    rows.find((r) => r.title.toUpperCase().includes(upper)) ??
    rows.find((r) => r.ticker.toUpperCase().includes(upper));
  return byName ? { cik: cikPad(byName.cik_str), name: byName.title, ticker: byName.ticker } : null;
}

export function getCompanyFacts(cik: string): Promise<CompanyFacts> {
  const c = cikPad(cik);
  return edgarGet<CompanyFacts>(
    `${DATA_BASE}/api/xbrl/companyfacts/CIK${c}.json`,
    `sec:companyfacts:${c}`,
    60 * 60 * 6,
  );
}
export function getSubmissions(cik: string): Promise<Submissions> {
  const c = cikPad(cik);
  return edgarGet<Submissions>(
    `${DATA_BASE}/submissions/CIK${c}.json`,
    `sec:submissions:${c}`,
    60 * 60 * 6,
  );
}

// Assemble the tear sheet AND return the underlying manifest, so a caller (the /sec route)
// can persist the FactManifest to the tenant workspace as a side effect of rendering.
export async function assembleEdgar(
  query: string,
): Promise<{ ts: TearSheet; manifest: FactManifest } | null> {
  const resolved = await resolveCik(query);
  if (!resolved) return null;
  const [sub, cf] = await Promise.all([getSubmissions(resolved.cik), getCompanyFacts(resolved.cik)]);
  const manifest = mapEdgarToManifest(sub, cf);
  const fixture = mapEdgarToFixture(sub, cf, manifest);
  return { ts: assembleTearSheet(manifest, fixture), manifest };
}

export async function assembleEdgarTearSheet(query: string): Promise<TearSheet | null> {
  const r = await assembleEdgar(query);
  return r?.ts ?? null;
}
