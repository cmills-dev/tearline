// lib/sources/companiesHouseLive.ts
// REAL Companies House LIVE-DATA path. Fetches the public register over HTTPS and maps
// the STRUCTURED fields into the same provenance-bearing Fact / FactManifest shapes the
// rest of the engine already consumes, so a live record renders through the existing
// SheetView / assemble pipeline with no downstream change.
//
// Honesty boundary: the Companies House structured API carries NO profit-and-loss
// figures (turnover, EBITDA, leverage). Those live inside the accounts documents
// (iXBRL / PDF). We therefore resolve every financial line as R4 ABSTAIN with an
// attempt log, and never invent a number.

import type {
  ChargeItem,
  ChargesList,
  CompanyProfile,
  CompanySearchResult,
} from "./companiesHouse";
import type { BorrowerFixture, PeriodMeta } from "./fixtures/types";
import { contentHash } from "../engine/hash";
import { assembleTearSheet, type TearSheet } from "../engine/assemble";
import type {
  AttemptLogEntry,
  EntityMeta,
  Fact,
  FactManifest,
  FactValueKind,
  Provenance,
  SourceDocument,
  VerificationCheck,
  VerificationState,
} from "../engine/types";
import { DERIVED_WITH_BORROWINGS_SPLIT, landFinancialLines } from "../engine/buildManifest";
import { classifyPdf, pdfDeclaresFont, pdfToText, extractFinancialsFromText, type PdfAbstention, type PdfExtraction, type PdfKind } from "./pdfAccounts";
import { fetchChDocument } from "./fetchDoc";
import { MB } from "./fetchLimits";
import { chBeforeAttempt, chFetchText } from "./chHttp";
import { resolveLei } from "./gleif";
import { getOcrProvider } from "../ocr/config";
import { ocrPdf } from "../ocr/ocrPdf";
import { extractFinancials, type ExtractedFinancials, type ExtractedLine } from "./ixbrl";
import { getCache } from "../cache/cache";
import {
  accountsTypeLabel,
  documentFormats,
  fetchAccountsFilingHistory,
  selectLatestAccountsFiling,
  type DocumentFormats,
  type SelectedAccountsFiling,
} from "../resolve";
import { countPdfPages, readScannedAccounts, type VisionDeps } from "../vision/client";
import { applyVerification, createVisionVerifier, passThroughVerifier } from "../vision/verify";
import { abstainTable, DebtNoteFacilityReader, type FacilityReader } from "../vision/capitalStructure";
import type { CapitalStructure } from "../engine/types";
import type {
  ManifestStage,
  StageCallback,
  VisionReadResult,
  VisionVerifier,
} from "../vision/types";
import { visionLines, type VisionFigure, type VisionLines } from "./visionAccounts";

const CH_BASE = "https://api.company-information.service.gov.uk";

// Cache TTLs (seconds). Company data changes slowly, so profile / charges are cached for
// c. 1 hour and the heavier accounts iXBRL document for c. 6 hours. A miss still fetches,
// and only a successful, non-error result is ever written, so the cache never hides a
// missing key or an upstream failure.
const TTL_PROFILE = 60 * 60;
const TTL_CHARGES = 60 * 60;
const TTL_ACCOUNTS = 6 * 60 * 60;

// The public, human-readable record every fact points at for provenance.
export function publicRecordUrl(number: string): string {
  return `https://find-and-update.company-information.service.gov.uk/company/${encodeURIComponent(
    number
  )}`;
}

// ---------------------------------------------------------------------------
// Auth + fetch
// ---------------------------------------------------------------------------
// Companies House uses HTTP Basic auth with the API key as the USERNAME and an empty
// password. A free key comes from developer.company-information.service.gov.uk.

function requireApiKey(): string {
  const key = process.env.CH_API_KEY;
  if (!key) throw new Error("CH_API_KEY not set");
  return key;
}

function authHeader(): string {
  const key = requireApiKey();
  const token = Buffer.from(`${key}:`).toString("base64");
  return `Basic ${token}`;
}

async function chGet<T>(path: string): Promise<T> {
  // Calls requireApiKey() first so a missing key throws the typed error before any
  // network work happens.
  const header = authHeader();
  // Global budget guard: back off before we approach CH's 600 / 5 min ceiling. Throws a
  // typed ChBudgetError the /live UI surfaces honestly. chFetchText charges it before every
  // attempt, retries included, after the pacer (WP-BE14).
  // Timeout + size cap: a CH JSON record is small, so a modest cap never bites real data but bounds
  // a hung or pathological upstream (the class of OOM/DoS the raw fetch left open). Paced across
  // runs and retried on a network error, a 429 or a 5xx (chHttp.ts).
  const res = await chFetchText(`${CH_BASE}${path}`, {
    headers: { Authorization: header },
    accept: "application/json",
    maxBytes: 16 * MB,
    timeoutMs: 20_000,
  });
  if (res.status === 404) throw new Error(`Companies House: not found for ${path}`);
  if (res.status === 401 || res.status === 403) {
    throw new Error("Companies House: authentication failed. Check CH_API_KEY.");
  }
  if (res.status === 429) {
    throw new Error("Companies House: rate limit exceeded (600 requests / 5 min).");
  }
  if (!res.ok) {
    throw new Error(`Companies House: unexpected status ${res.status} for ${path}`);
  }
  return JSON.parse(res.text) as T;
}

// ---------------------------------------------------------------------------
// Public connector surface
// ---------------------------------------------------------------------------

export function searchCompanies(q: string): Promise<CompanySearchResult> {
  return chGet<CompanySearchResult>(
    `/search/companies?q=${encodeURIComponent(q)}&items_per_page=10`
  );
}

export async function getProfile(number: string): Promise<CompanyProfile> {
  // Live data requires a key even on a cache hit: assert it first so a missing key still
  // errors honestly rather than being masked by a previously cached record.
  requireApiKey();
  // Cache by company number for c. 1 hour. A miss fetches live; only a successful profile
  // is ever stored, so the cache never hides an upstream failure.
  const cache = getCache();
  const cacheKey = `ch:profile:${number}`;
  const cached = await cache.get<CompanyProfile>(cacheKey);
  if (cached) return cached;
  const profile = await chGet<CompanyProfile>(`/company/${encodeURIComponent(number)}`);
  await cache.set(cacheKey, profile, TTL_PROFILE);
  return profile;
}

// Officers and PSC feed the relationship graph (people + ownership). Cached like the rest;
// a 404 (no officers / no PSC filed) is a valid empty answer, not an error.
export async function getOfficers(number: string): Promise<{ items?: { name: string; officer_role?: string; appointed_on?: string; resigned_on?: string }[] }> {
  requireApiKey();
  const cache = getCache();
  const key = `ch:officers:${number}`;
  const cached = await cache.get<{ items?: unknown[] }>(key);
  if (cached) return cached as never;
  const data = await chGet<{ items?: never[] }>(`/company/${encodeURIComponent(number)}/officers`).catch((e: unknown) => {
    if (e instanceof Error && e.message.includes("not found")) return { items: [] };
    throw e;
  });
  await cache.set(key, data, TTL_PROFILE);
  return data as never;
}

export async function getPsc(number: string): Promise<{ items?: { name: string; kind?: string; natures_of_control?: string[]; notified_on?: string; ceased_on?: string }[] }> {
  requireApiKey();
  const cache = getCache();
  const key = `ch:psc:${number}`;
  const cached = await cache.get<{ items?: unknown[] }>(key);
  if (cached) return cached as never;
  const data = await chGet<{ items?: never[] }>(`/company/${encodeURIComponent(number)}/persons-with-significant-control`).catch((e: unknown) => {
    if (e instanceof Error && e.message.includes("not found")) return { items: [] };
    throw e;
  });
  await cache.set(key, data, TTL_PROFILE);
  return data as never;
}

export async function getCharges(number: string): Promise<ChargesList> {
  // Live data requires a key even on a cache hit; assert it first (see getProfile).
  requireApiKey();
  // A company with no charges register returns 404; treat that as an empty register
  // rather than an error, since "no secured debt" is a valid, informative answer. Cached
  // by company number for c. 1 hour, including the legitimate empty result.
  const cache = getCache();
  const cacheKey = `ch:charges:${number}`;
  const cached = await cache.get<ChargesList>(cacheKey);
  if (cached) return cached;
  const charges = await chGet<ChargesList>(
    `/company/${encodeURIComponent(number)}/charges`
  ).catch((err: unknown) => {
    if (err instanceof Error && err.message.includes("not found")) {
      return { items: [], total_count: 0 } as ChargesList;
    }
    throw err;
  });
  await cache.set(cacheKey, charges, TTL_CHARGES);
  return charges;
}

// ---------------------------------------------------------------------------
// Insolvency register (a cited distress catalyst source)
// ---------------------------------------------------------------------------
// GET /company/{n}/insolvency returns the filed insolvency case(s). A company with no
// insolvency history returns 404; that is a valid, informative "no cases on the register"
// answer, not an error, so we tolerate it and return null exactly like the other fetchers.

export interface InsolvencyCaseDate {
  type?: string; // e.g. "administration-started-on", "wound-up-on"
  date?: string; // YYYY-MM-DD
}
export interface InsolvencyCase {
  type?: string; // e.g. "in-administration", "compulsory-liquidation"
  dates?: InsolvencyCaseDate[];
  practitioners?: Array<{ name?: string; role?: string }>;
}
export interface InsolvencyResult {
  cases?: InsolvencyCase[];
  status?: string[];
}

export async function getInsolvency(number: string): Promise<InsolvencyResult | null> {
  // Live data requires a key even on a cache hit; assert it first (see getProfile).
  requireApiKey();
  const cache = getCache();
  const cacheKey = `ch:insolvency:${number}`;
  const cached = await cache.get<InsolvencyResult>(cacheKey);
  if (cached) return cached;
  const data = await chGet<InsolvencyResult>(
    `/company/${encodeURIComponent(number)}/insolvency`
  ).catch((err: unknown) => {
    // A 404 means no insolvency history is filed: a valid empty answer, not an error.
    if (err instanceof Error && err.message.includes("not found")) return null;
    throw err;
  });
  // Only a real, non-null result is cached; a null (no history) is left uncached so it is
  // re-checked and never confused with a cache miss.
  if (data) await cache.set(cacheKey, data, TTL_PROFILE);
  return data;
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

const REGISTER_SOURCE = "ch-live-register";
const CHARGES_SOURCE = "ch-live-charges";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatAddress(a: CompanyProfile["registered_office_address"]): string {
  if (!a) return "";
  return [a.address_line_1, a.locality, a.postal_code, a.country]
    .filter(Boolean)
    .join(", ");
}

// The primary reporting period, derived from the last-accounts made-up-to date. Live
// records without any filed accounts fall back to a generic latest period.
export function livePrimaryPeriod(profile: CompanyProfile): PeriodMeta {
  const madeUpTo = profile.accounts?.last_accounts?.made_up_to;
  if (madeUpTo) {
    return {
      key: `FY${madeUpTo.slice(0, 4)}`,
      label: `Year ended ${madeUpTo}`,
      end: madeUpTo,
      isLatest: true,
    };
  }
  return { key: "LATEST", label: "Latest reported period", end: "", isLatest: true };
}

function registerProvenance(number: string, snippet: string, locator: string): Provenance {
  return {
    sourceId: REGISTER_SOURCE,
    tag: "Reg",
    documentName: "Companies House public register (structured record)",
    locator,
    snippet,
    retrievedAt: today(),
    contentHash: contentHash(`${REGISTER_SOURCE}|${locator}|${snippet}`),
  };
}

const ACCOUNTS_SOURCE = "ch-live-accounts";

// Provenance for a figure read from the accounts iXBRL: it cites the exact tagged
// concept, the value the filer wrote, and the period, so the EvidenceCard traces the
// number to the filer's own tag rather than to any inference of ours.
function accountsProvenance(line: ExtractedLine, url: string): Provenance {
  const fromPdf = line.concept.startsWith("pdf:");
  const fromOcr = line.concept.startsWith("ocr:");
  // For a PDF / OCR line the grounding snippet IS the verbatim source line; for an iXBRL
  // line it is the tagged concept and the value the filer wrote. A line summed from several tags
  // says how (borrowings by maturity, WP-BE13).
  const snippet = fromPdf || fromOcr
    ? line.rawText
    : `${line.concept} = ${line.rawText}${line.unit ? " " + line.unit : ""} (period end ${line.periodEnd || "n/a"})${line.note ? ". " + line.note : ""}`;
  const documentName = fromOcr
    ? "Annual accounts (OCR of scanned PDF, Companies House filing)"
    : fromPdf
      ? "Annual accounts (PDF text layer, Companies House filing)"
      : "Annual accounts (iXBRL, Companies House filing)";
  return {
    sourceId: ACCOUNTS_SOURCE,
    tag: "Acc",
    documentName,
    locator: url,
    snippet,
    retrievedAt: today(),
    contentHash: contentHash(`${ACCOUNTS_SOURCE}|${line.concept}|${line.rawText}|${line.value}`),
  };
}

// A base financial line read from the accounts document, as an R1 reported Fact. The
// resolution ladder then synthesises EBITDA, net debt, leverage and cover from these.
function reportedFinancialFact(line: ExtractedLine, period: string, url: string): Fact {
  return {
    id: `${line.metric}.${period}`,
    metric: line.metric,
    label: line.label,
    period,
    kind: "currency",
    value: line.value,
    unit: line.unit || "GBP",
    rung: "R1",
    provenance: accountsProvenance(line, url),
    verification: { status: "SINGLE_SOURCE", checks: [] },
    ...(line.precision ? { precision: line.precision } : {}),
  };
}

// ---------------------------------------------------------------------------
// Figures read from a scan by the vision model
// ---------------------------------------------------------------------------
// A scan has no text layer, so there is no passage to quote and the Citations API returns
// nothing (audit finding 19). The citation a scan supports is the PDF page, the label and the
// figure exactly as printed, the scale caption, the statement, the period and the verification
// tag. That whole string is the snippet, so an evidence card shows a reader where to look
// rather than pretending to quote.

const VISION_SOURCE = "ch-live-accounts-vision";

function visionProvenance(fig: VisionFigure, locator: string): Provenance {
  return {
    sourceId: VISION_SOURCE,
    tag: "Acc",
    documentName: "Annual accounts (scanned PDF, read page by page by a vision model)",
    locator,
    snippet: fig.citation,
    retrievedAt: today(),
    contentHash: contentHash(`${VISION_SOURCE}|${fig.key}|${fig.line.pdfPageIndex}|${fig.line.figureText}|${fig.value}`),
    kind: "scan-read",
    page: fig.line.pdfPageIndex,
    printedText: fig.line.figureText,
    tags: fig.tags,
  };
}

// The checks a double-read figure carries: the double read itself, then every printed tie it
// took part in that held. A held tie is a structural pass; a double read alone is still one
// source read twice, so it stays SINGLE_SOURCE. Ties that could not run go in the attempt log.
function visionChecks(fig: VisionFigure, period: string): VerificationState {
  const e = fig.tag.evidence;
  const checks: VerificationCheck[] = [];
  if (e) {
    checks.push({
      id: `double-read.${fig.metric}.${period}`,
      label: "Double read",
      identity: "two independent reads agree on value, scale and period",
      passed: true,
      detail: `First read "${e.first.figureText}" on PDF page ${e.first.pdfPageIndex}, second read "${e.second.figureText}" on PDF page ${e.second.pdfPageIndex}, both under ${e.second.headerScaleCaption}, column "${e.second.columnHeading ?? ""}".`,
    });
    for (const t of e.ties.filter((t) => t.status === "pass")) {
      checks.push({ id: `${t.id}.${period}`, label: t.label, identity: t.label, passed: true, detail: t.detail });
    }
  }
  return { status: fig.tags.includes("tie-pass") ? "STRUCTURAL_PASS" : "SINGLE_SOURCE", checks };
}

function visionFact(fig: VisionFigure, period: string, locator: string): Fact {
  return {
    id: `${fig.metric}.${period}`,
    metric: fig.metric,
    label: fig.label,
    period,
    kind: "currency",
    value: fig.value,
    unit: fig.unit,
    rung: "R1",
    provenance: visionProvenance(fig, locator),
    verification: visionChecks(fig, period),
    ...(fig.precision ? { precision: fig.precision } : {}),
    attemptLog: [
      {
        step: "R1 reported (scanned accounts, read page by page by a vision model)",
        outcome: "found",
        detail: `${fig.citation} Scale applied: x${fig.scale}.`,
      },
      ...(fig.tag.evidence?.ties ?? [])
        .filter((t) => t.status === "not-run")
        .map((t) => ({ step: `Tie: ${t.label}`, outcome: "insufficient" as const, detail: t.detail })),
    ],
  };
}

// A base line the reader could not read. The reason is the model's own, or the client's when no
// call was made (too large, unconfigured, cache-only), so a gap always says which.
function visionAbstainFact(
  metric: string,
  label: string,
  period: string,
  reason: string,
  filingDescription: string
): Fact {
  return {
    id: `${metric}.${period}`,
    metric,
    label,
    period,
    kind: "currency",
    value: null,
    unit: "GBP",
    rung: "R4",
    provenance: null,
    verification: { status: "NOT_APPLICABLE", checks: [] },
    attemptLog: [
      {
        step: "R1 reported (scanned accounts, read page by page by a vision model)",
        outcome: "missing",
        detail: `Abstained on ${filingDescription}: ${reason}.`,
      },
    ],
  };
}

// A base line the PDF text layer found a row for and would not take (WP-GRPCHK).
function textAbstainFact(metric: string, label: string, period: string, reason: string, filingDescription: string): Fact {
  return {
    id: `${metric}.${period}`,
    metric,
    label,
    period,
    kind: "currency",
    value: null,
    unit: "GBP",
    rung: "R4",
    provenance: null,
    verification: { status: "NOT_APPLICABLE", checks: [] },
    attemptLog: [
      {
        step: "R1 reported (accounts PDF text layer, read row by row)",
        outcome: "missing",
        detail: `Abstained on ${filingDescription}: ${reason}.`,
      },
    ],
  };
}

interface DocumentMetadata {
  links?: { document?: string };
  resources?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Which filing to read
// ---------------------------------------------------------------------------
// The old code took `filing-history?category=accounts&items_per_page=1`, which is whatever the
// register received most recently in that category. An AA01 (change of accounting reference
// date) carries no figures, and an amended AAMD can sit above the AA it amends, so the newest
// item was regularly not the accounts (audit finding 6). Selection is now the resolver's
// (lib/resolve/filings.ts): only AA and AAMD with a document link, ordered by the period they
// cover.

export interface SelectedFilingDocument {
  filing: SelectedAccountsFiling;
  formats: DocumentFormats;
  contentUrl: string | null;
  pageCount: number; // from the filing history item; 0 when the register does not say
}

async function fetchDocumentMetadata(metaUrl: string, header: string): Promise<DocumentMetadata | null> {
  const res = await chFetchText(metaUrl, {
    headers: { Authorization: header },
    accept: "application/json",
    maxBytes: 8 * MB,
    timeoutMs: 20_000,
  });
  if (!res.ok) return null;
  try {
    return JSON.parse(res.text) as DocumentMetadata;
  } catch {
    return null;
  }
}

// The accounts filing to read, and the formats it offers. Null when the company has filed no
// accounts, or the document metadata hop failed. Never throws for a missing document. A filing
// history that could not be fetched DOES throw (WP-QA05): swallowed to an empty list, an outage
// read as "no accounts filing on the register", which is a claim about the company.
export async function selectAccountsDocument(number: string): Promise<SelectedFilingDocument | null> {
  const header = authHeader(); // throws the typed error if CH_API_KEY is unset
  const items = await fetchAccountsFilingHistory(number);
  const filing = selectLatestAccountsFiling(items);
  if (!filing) return null;
  const pageCount = items.find((i) => i.transaction_id === filing.transactionId)?.pages ?? 0;
  const meta = await fetchDocumentMetadata(filing.documentMetadataUrl, header);
  if (!meta) return null;
  return {
    filing: { ...filing, formats: documentFormats(meta) },
    formats: documentFormats(meta),
    contentUrl: meta.links?.document ?? null,
    pageCount,
  };
}

// Fetch the selected accounts filing's inline XBRL, when the document offers it. Returns null
// when there is no accounts filing, or it is PDF only, or the hops fail.
// The text layer's lines, dated by the filing that was read. The reader prints no period, and the
// lines used to take the profile's last-accounts date, which is cached for an hour and can name a
// different year from the filing chosen: FY2024 figures landed as FY2023, or the reverse
// (WP-QA03 E1). The filing's own made-up date is the period; the profile is the fallback only
// when the register gives no date.
export function textLayerExtraction(
  pdf: PdfExtraction,
  madeUpDate: string | null,
  profile: CompanyProfile,
): ExtractedFinancials {
  const periodEnd = madeUpDate || livePrimaryPeriod(profile).end;
  return {
    periodEnd,
    currency: "GBP",
    lines: pdf.lines.map((l) => ({ ...l, periodEnd: l.periodEnd || periodEnd })),
  };
}

export async function getLatestAccountsIxbrl(
  number: string,
  preselected?: SelectedFilingDocument | null,
): Promise<string | null> {
  const header = authHeader();
  // The filing is chosen FIRST and the cache is keyed by its transaction id. Keyed by company
  // number alone, a document cached for filing A was served for up to six hours after the
  // builder had chosen filing B, so the figures came from A while the citation named B
  // (WP-QA03 E2). The builder passes the document it already selected, so this costs no hop.
  const selected = preselected ?? (await selectAccountsDocument(number));
  if (!selected?.contentUrl || !selected.formats.ixbrl) return null;
  // Cache the parsed document text for c. 6 hours. Only a non-null document is cached: a
  // null ("no iXBRL available") is left uncached so it is re-checked.
  const cache = getCache();
  const cacheKey = `ch:accounts-ixbrl:${number}:${selected.filing.transactionId}`;
  const cached = await cache.get<string>(cacheKey);
  if (cached) return cached;
  const text = await fetchIxbrlText(selected.contentUrl, header);
  if (text) await cache.set(cacheKey, text, TTL_ACCOUNTS);
  return text;
}

// Fetch the iXBRL document through the shared manual-redirect helper (the same path the PDF
// fetch uses), so the CH Authorization header is scoped to hop 1 and never forwarded to the
// pre-signed storage host (e.g. S3) the CH content endpoint 302-redirects to. beforeAttempt
// charges each attempt (incl. retries) to the CH budget.
async function fetchIxbrlText(contentUrl: string, header: string): Promise<string | null> {
  const buf = await fetchChDocument(contentUrl, header, {
    accept: "application/xhtml+xml",
    beforeAttempt: chBeforeAttempt,
  });
  if (!buf) return null;
  return new TextDecoder("utf-8").decode(buf);
}

// Hardened download: auth to CH only, bare headers to S3, retry/backoff on truncation, size cap,
// and beforeAttempt charges each attempt (incl. retries) to the CH budget.
async function fetchPdfBytes(contentUrl: string, header: string): Promise<Uint8Array | null> {
  const buf = await fetchChDocument(contentUrl, header, {
    accept: "application/pdf",
    beforeAttempt: chBeforeAttempt,
  });
  return buf && buf.length > 0 ? buf : null;
}

// The selected accounts filing as PDF TEXT. Returns null when there is no accounts filing, no
// PDF resource, or the hops fail. Never throws: the caller treats null as "financials abstain".
export async function getLatestAccountsPdfText(number: string): Promise<string | null> {
  const buf = await getLatestAccountsPdfBytes(number);
  if (!buf) return null;
  const text = await pdfToText(buf);
  if (!text || text.length < 40) return null;
  return text;
}

// The selected accounts filing as raw PDF BYTES (or null). Throws when the filing history
// cannot be fetched, as selectAccountsDocument does.
export async function getLatestAccountsPdfBytes(number: string): Promise<Uint8Array | null> {
  const header = authHeader();
  const selected = await selectAccountsDocument(number);
  if (!selected?.contentUrl || !selected.formats.pdf) return null;
  return fetchPdfBytes(selected.contentUrl, header);
}

function structuredFact(
  metric: string,
  label: string,
  period: string,
  value: string,
  provenance: Provenance
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
    provenance,
    verification: { status: "SINGLE_SOURCE", checks: [] },
  };
}

// A financial line the structured API cannot supply: honest R4 abstain with a log.
function abstainFinancialFact(
  metric: string,
  label: string,
  period: string,
  kind: FactValueKind,
  unit: string
): Fact {
  const log: AttemptLogEntry[] = [
    {
      step: "R1 reported (Companies House structured API)",
      outcome: "missing",
      detail:
        "The structured Public Data API exposes the register only. P&L and balance-sheet figures are not present as structured fields.",
    },
    {
      step: "R2 synthesised / R3 proxy",
      outcome: "insufficient",
      detail:
        "reported inside the accounts filing (iXBRL/PDF); enable the document parser or entitled source to extract",
    },
  ];
  return {
    id: `${metric}.${period}`,
    metric,
    label,
    period,
    kind,
    value: null,
    unit,
    rung: "R4",
    provenance: null,
    verification: { status: "NOT_APPLICABLE", checks: [] },
    attemptLog: log,
  };
}

function chargeMetric(charge: ChargeItem): string {
  return `charge${charge.charge_number}`;
}

function chargeeName(charge: ChargeItem): string {
  const names = (charge.persons_entitled ?? []).map((p) => p.name).filter(Boolean);
  return names.length ? names.join(", ") : "Not stated";
}

// Each registered charge becomes a secured-debt line: a Fact carrying its status, plus
// a capital tranche describing the chargee, security and classification.
function chargeFact(number: string, charge: ChargeItem, period: string): Fact {
  const description =
    charge.classification?.description ?? "Registered charge";
  const security = charge.secured_details?.description ?? description;
  const snippet = `${description} in favour of ${chargeeName(
    charge
  )}; status ${charge.status}. Secured: ${security}`;
  const provenance: Provenance = {
    sourceId: CHARGES_SOURCE,
    tag: "NF",
    documentName: "Companies House charges register",
    locator: `${publicRecordUrl(number)}/charges`,
    snippet,
    retrievedAt: today(),
    contentHash: contentHash(`${CHARGES_SOURCE}|${charge.charge_number}|${snippet}`),
  };
  return {
    id: `${chargeMetric(charge)}.${period}`,
    metric: chargeMetric(charge),
    label: description,
    period,
    kind: "text",
    // Amounts are not held on the charges register, so the value is the charge status.
    value: charge.status === "outstanding" ? "Outstanding" : charge.status,
    unit: "",
    rung: "R1",
    provenance,
    verification: { status: "SINGLE_SOURCE", checks: [] },
  };
}

// ---------------------------------------------------------------------------
// Catalyst facts: insolvency, adverse status, overdue filings, going-concern text.
// These are kept in a clear, non-financial namespace (insolvency.* / status.* /
// filing.* / goingConcern.*) so the tear-sheet and figure-eval never mistake them for a
// financial metric. Every one is cited to a real source fact, or it is not landed at all.
// ---------------------------------------------------------------------------

const INSOLVENCY_SOURCE = "ch-live-insolvency";

// Fields the live CH profile carries at runtime but that are not on the shared
// CompanyProfile type. Read defensively so a missing field simply abstains.
interface LiveProfileExtras {
  company_status_detail?: string; // e.g. "active-proposal-to-strike-off"
  confirmation_statement?: { overdue?: boolean };
  has_insolvency_history?: boolean;
}

function insolvencyProvenance(number: string, snippet: string): Provenance {
  return {
    sourceId: INSOLVENCY_SOURCE,
    tag: "Reg",
    documentName: "Companies House insolvency record (structured)",
    locator: `${publicRecordUrl(number)}/insolvency`,
    snippet,
    retrievedAt: today(),
    contentHash: contentHash(`${INSOLVENCY_SOURCE}|${snippet}`),
  };
}

// A human label for an insolvency case type enum, e.g. "in-administration" -> "In
// administration". Purely cosmetic; the raw enum stays in the metric id and snippet.
function humaniseCaseType(type: string): string {
  const s = type.replace(/-/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// The salient date on a case: prefer a "started"/"wound-up"/"commenced" event, else the
// first dated event. Returns null when the case carries no usable date.
function salientCaseDate(c: InsolvencyCase): InsolvencyCaseDate | null {
  const dated = (c.dates ?? []).filter((d) => d.date);
  if (dated.length === 0) return null;
  const started = dated.find((d) => /started|wound-up|commenced|opened/i.test(d.type ?? ""));
  return started ?? dated[0];
}

// One cited R1 fact per filed insolvency case. Abstains (returns null) if the case has no
// type at all; a case is still landed when only the date is missing (the type alone is a
// catalyst), with the date reported as "date not stated".
function insolvencyCaseFact(number: string, c: InsolvencyCase, period: string): Fact | null {
  const type = c.type;
  if (!type) return null;
  const salient = salientCaseDate(c);
  const label = humaniseCaseType(type);
  const practitioners = (c.practitioners ?? []).map((p) => p.name).filter(Boolean);
  const dateBit = salient ? `; ${salient.type ?? "date"} ${salient.date}` : "; date not stated";
  const practBit = practitioners.length ? `; practitioner(s) ${practitioners.join(", ")}` : "";
  const snippet = `Insolvency case: ${type}${dateBit}${practBit}`;
  return {
    id: `insolvency.${type}.${period}`,
    metric: `insolvency.${type}`,
    label: `Insolvency: ${label}`,
    period,
    kind: "text",
    value: salient ? `${label} (${salient.date})` : label,
    unit: "",
    rung: "R1",
    provenance: insolvencyProvenance(number, snippet),
    verification: { status: "SINGLE_SOURCE", checks: [] },
  };
}

// The ISA 570 standardised phrase. We fire ONLY on this exact wording (either spelling of
// "related"/"relating"), never on an ordinary going-concern basis note, so the heuristic is
// conservative by construction.
const ISA570_PHRASES = [
  "material uncertainty related to going concern",
  "material uncertainty relating to going concern",
];

// Scan accounts text (iXBRL XHTML or PDF/OCR text) for the ISA 570 phrase. Strips tags and
// collapses whitespace first so a phrase split across markup still matches. Returns a short
// verbatim quote around the match to carry as provenance, or null when the phrase is absent
// or there is no text (in which case NOTHING is landed and the signal abstains).
// Negation cues that turn the ISA 570 phrase into a CLEAN finding. Most healthy accounts say
// "no material uncertainty related to going concern" or "we have not identified a material
// uncertainty ...", so a bare phrase match would false-positive across the whole filing base.
// We reject a match when a negator appears close before it.
const GC_NEGATORS = /\b(no|not|without|any|n't|nor|neither)\b/;

export function scanGoingConcern(text: string | null | undefined): string | null {
  if (!text) return null;
  const normalised = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  const hay = normalised.toLowerCase();
  for (const phrase of ISA570_PHRASES) {
    // Scan EVERY occurrence: a document may carry a negated mention ("no material uncertainty
    // ...") and, separately, the real material-uncertainty section heading. Only a
    // non-negated occurrence fires.
    let from = 0;
    for (;;) {
      const idx = hay.indexOf(phrase, from);
      if (idx < 0) break;
      const preceding = hay.slice(Math.max(0, idx - 40), idx);
      if (!GC_NEGATORS.test(preceding)) {
        const start = Math.max(0, idx - 80);
        const end = Math.min(normalised.length, idx + phrase.length + 80);
        return normalised.slice(start, end).trim();
      }
      from = idx + phrase.length;
    }
  }
  return null;
}

// The going-concern material-uncertainty fact. It is a TEXT HEURISTIC on unstructured
// accounts text, never a filer-tagged concept, so it lands at R3 (never R1) and carries the
// matched quote as its grounding provenance.
function goingConcernFact(number: string, quote: string, period: string, url: string): Fact {
  return {
    id: `goingConcern.materialUncertainty.${period}`,
    metric: "goingConcern.materialUncertainty",
    label: "Going concern: material uncertainty",
    period,
    kind: "text",
    value: "Material uncertainty related to going concern (ISA 570 phrase present in the accounts text)",
    unit: "",
    rung: "R3",
    provenance: {
      sourceId: ACCOUNTS_SOURCE,
      tag: "Acc",
      documentName: "Annual accounts (Companies House filing) - text scan",
      locator: url,
      snippet: quote,
      retrievedAt: today(),
      contentHash: contentHash(`${ACCOUNTS_SOURCE}|goingConcern|${quote}`),
    },
    verification: { status: "SINGLE_SOURCE", checks: [] },
    attemptLog: [
      {
        step: "R3 text heuristic (ISA 570 standardised phrase)",
        outcome: "found",
        detail:
          `Matched the standardised "material uncertainty related to going concern" phrase in the accounts text. A conservative text finding, not a filer-tagged concept. Company number ${number}.`,
      },
    ],
  };
}

// A companion "vintage" fact for an OUTSTANDING charge that carries a created_on date. It
// records the charge creation date so the maturity/refinancing-window PROXY signal can read
// an age. Landed ONLY for outstanding charges with a created_on, so its mere presence means
// "outstanding + dated", and the proxy abstains when it is absent. Namespaced securedVintage
// (not charge*) so it is never confused with the charge status fact or a financial figure.
function securedVintageFact(number: string, charge: ChargeItem, period: string): Fact | null {
  if (charge.status !== "outstanding" || !charge.created_on) return null;
  const desc = charge.classification?.description ?? "Registered charge";
  const snippet = `Charge ${charge.charge_number} (${desc}) in favour of ${chargeeName(
    charge
  )}; status outstanding; created ${charge.created_on}. Note: the charges register carries no maturity or end date.`;
  return {
    id: `securedVintage.${charge.charge_number}.${period}`,
    metric: `securedVintage.${charge.charge_number}`,
    label: `Secured charge ${charge.charge_number} created`,
    period,
    kind: "text",
    value: charge.created_on,
    unit: "",
    rung: "R1",
    provenance: {
      sourceId: CHARGES_SOURCE,
      tag: "NF",
      documentName: "Companies House charges register",
      locator: `${publicRecordUrl(number)}/charges`,
      snippet,
      retrievedAt: today(),
      contentHash: contentHash(`${CHARGES_SOURCE}|vintage|${charge.charge_number}|${charge.created_on}`),
    },
    verification: { status: "SINGLE_SOURCE", checks: [] },
  };
}

// ---------------------------------------------------------------------------
// Manifest builder (pure) + fetch wrapper
// ---------------------------------------------------------------------------

export interface LiveMapOptions {
  // Base lines read from the accounts iXBRL, or from a genuine PDF text layer.
  extracted?: ExtractedFinancials;
  insolvency?: InsolvencyResult | null;
  // Raw accounts text for the going-concern scan. A scan has none.
  accountsText?: string | null;
  insolvencyFetchFailed?: boolean;
  // The accounts filing history could not be fetched, so no accounts were read. Not the same as a
  // company with no accounts filing: the manifest says which (WP-QA05).
  filingFetchFailed?: boolean;
  // Base lines read off the page images of a scanned filing, with their verification tags.
  vision?: VisionLines | null;
  // The read itself, for the outcome and the transaction id.
  visionRead?: VisionReadResult | null;
  // The facilities table from the debt note of the scan (WP-BE16), agreed by two reads or abstained.
  capitalStructure?: CapitalStructure | null;
  // The accounts filing the resolver picked, whose accounts-type label the entity carries.
  filing?: SelectedAccountsFiling | null;
  // Lines the PDF text layer found a row for and would not take, with the reason (WP-GRPCHK: a
  // company-only statement or column in a group filing, or a blank first column).
  textAbstentions?: PdfAbstention[];
}

export function mapLiveToManifest(
  profile: CompanyProfile,
  charges: ChargesList,
  options: LiveMapOptions = {}
): FactManifest {
  const {
    extracted,
    insolvency,
    accountsText,
    insolvencyFetchFailed = false,
    filingFetchFailed = false,
    vision = null,
    visionRead = null,
    filing = null,
    capitalStructure = null,
    textAbstentions = [],
  } = options;
  const number = profile.company_number;
  const period = livePrimaryPeriod(profile);
  const pk = period.key;
  const url = publicRecordUrl(number);
  const facts: Record<string, Fact> = {};

  // --- Structured R1 facts (sector, incorporation, accounts reference, geography) ---
  const sic = profile.sic_codes ?? [];
  facts[`sector.${pk}`] = structuredFact(
    "sector",
    "Sector (SIC codes)",
    pk,
    sic.length ? sic.join(", ") : "Not stated",
    registerProvenance(number, sic.length ? `SIC ${sic.join(", ")}` : "No SIC filed", url)
  );

  facts[`incorporation.${pk}`] = structuredFact(
    "incorporation",
    "Incorporated on",
    pk,
    profile.date_of_creation ?? "Not stated",
    registerProvenance(
      number,
      `Incorporated ${profile.date_of_creation ?? "not stated"} (${profile.type})`,
      url
    )
  );

  const madeUpTo = profile.accounts?.last_accounts?.made_up_to ?? "not stated";
  const nextDue = profile.accounts?.next_due ?? profile.accounts?.next_accounts?.due_on;
  const accountsRef = `Last accounts made up to ${madeUpTo}${
    nextDue ? `; next accounts due ${nextDue}` : ""
  }`;
  facts[`accountsReference.${pk}`] = structuredFact(
    "accountsReference",
    "Accounts reference dates",
    pk,
    accountsRef,
    registerProvenance(number, accountsRef, url)
  );

  const country =
    profile.registered_office_address?.country ?? profile.jurisdiction ?? "Not stated";
  facts[`geography.${pk}`] = structuredFact(
    "geography",
    "Geography (registered office)",
    pk,
    country,
    registerProvenance(number, `Registered office: ${formatAddress(profile.registered_office_address) || country}`, url)
  );

  // --- Capital structure from the charges register ---
  for (const charge of charges.items ?? []) {
    const cf = chargeFact(number, charge, pk);
    facts[cf.id] = cf;
    // Companion vintage fact for outstanding, dated charges (feeds the maturity PROXY).
    const vf = securedVintageFact(number, charge, pk);
    if (vf) facts[vf.id] = vf;
  }

  // --- Distress catalyst facts (each cited, or not landed at all) ---
  const extras = profile as CompanyProfile & LiveProfileExtras;

  // Insolvency case(s): one cited R1 fact per filed case.
  let insolvencyLanded = false;
  for (const c of insolvency?.cases ?? []) {
    const f = insolvencyCaseFact(number, c, pk);
    if (f) {
      facts[f.id] = f;
      insolvencyLanded = true;
    }
  }
  // If the insolvency register could NOT be read (a real fetch failure, not a 404 "no history"),
  // record an honest data-gap marker so the absence of insolvency facts is never presented as a
  // verified "no cases on the register". Namespaced dataGap.* (not insolvency.*) so it is never
  // mistaken for a filed case by any downstream reader. Not landed on a genuine clean-empty.
  if (insolvencyFetchFailed && !insolvencyLanded) {
    facts[`dataGap.insolvency.${pk}`] = {
      id: `dataGap.insolvency.${pk}`,
      metric: "dataGap.insolvency",
      label: "Insolvency register: not checked",
      period: pk,
      kind: "text",
      value: "The Companies House insolvency register could not be read on this run (fetch failed), so the absence of insolvency facts is UNVERIFIED, not a confirmed clean register.",
      unit: "",
      rung: "R4",
      provenance: insolvencyProvenance(number, "Insolvency register fetch failed; status could not be established."),
      verification: { status: "SINGLE_SOURCE", checks: [] },
      attemptLog: [
        {
          step: "GET /company/{n}/insolvency",
          outcome: "insufficient",
          detail: `The insolvency register fetch failed (not a 404). No insolvency conclusion can be drawn either way for company ${number}; re-check before relying on a clean register.`,
        },
      ],
    };
  }

  // The same honesty for the accounts: when the filing history could not be fetched, every
  // financial line abstains, and this marker says it was an outage, not an empty register.
  if (filingFetchFailed) {
    facts[`dataGap.accounts.${pk}`] = {
      id: `dataGap.accounts.${pk}`,
      metric: "dataGap.accounts",
      label: "Accounts filing: not checked",
      period: pk,
      kind: "text",
      value: "The Companies House filing history could not be read on this run (fetch failed), so no accounts were read. This is not a finding that the company has filed no accounts.",
      unit: "",
      rung: "R4",
      provenance: {
        sourceId: REGISTER_SOURCE,
        tag: "Reg",
        documentName: "Companies House filing history (accounts)",
        locator: `${url}/filing-history`,
        snippet: "Filing history fetch failed; whether an accounts filing exists could not be established.",
        retrievedAt: today(),
        contentHash: contentHash(`${REGISTER_SOURCE}|filing-history|fetch failed`),
      },
      verification: { status: "SINGLE_SOURCE", checks: [] },
      attemptLog: [
        {
          step: "GET /company/{n}/filing-history?category=accounts",
          outcome: "insufficient",
          detail: `The filing history fetch failed (not a 404). Whether company ${number} has an accounts filing could not be established; re-run before reading the empty financials as a finding.`,
        },
      ],
    };
  }

  // Company status, when it is anything other than active, and any status detail (e.g.
  // active-proposal-to-strike-off). Both cited to the register.
  const status = profile.company_status ?? "";
  if (status && status.toLowerCase() !== "active") {
    facts[`status.flag.${pk}`] = structuredFact(
      "status.flag",
      "Company status",
      pk,
      status,
      registerProvenance(number, `Company status: ${status}`, url)
    );
  }
  if (extras.company_status_detail) {
    facts[`status.detail.${pk}`] = structuredFact(
      "status.detail",
      "Company status detail",
      pk,
      extras.company_status_detail,
      registerProvenance(number, `Company status detail: ${extras.company_status_detail}`, url)
    );
  }

  // Overdue filings: landed only when actually overdue, so presence = a catalyst.
  if (profile.accounts?.next_accounts?.overdue === true || profile.accounts?.overdue === true) {
    facts[`filing.accountsOverdue.${pk}`] = structuredFact(
      "filing.accountsOverdue",
      "Accounts overdue",
      pk,
      "Overdue",
      registerProvenance(number, "Annual accounts overdue at Companies House", url)
    );
  }
  if (extras.confirmation_statement?.overdue === true) {
    facts[`filing.confirmationOverdue.${pk}`] = structuredFact(
      "filing.confirmationOverdue",
      "Confirmation statement overdue",
      pk,
      "Overdue",
      registerProvenance(number, "Confirmation statement overdue at Companies House", url)
    );
  }

  // Going-concern material uncertainty: a conservative text heuristic on the accounts text.
  // Fires only on the ISA 570 standardised phrase; otherwise nothing is landed (abstain).
  const gcQuote = scanGoingConcern(accountsText);
  let goingConcernLanded = false;
  if (gcQuote) {
    const f = goingConcernFact(number, gcQuote, pk, url);
    facts[f.id] = f;
    goingConcernLanded = true;
  }

  // --- Financial lines ---
  // When the accounts iXBRL was read, its base lines (turnover, operating profit, D&A,
  // cash, borrowings, net interest) land as R1 reported facts and the resolution ladder
  // synthesises EBITDA, net debt, leverage and cover from them, exactly as for a fixture.
  // Where a base line is not tagged, the ladder abstains rather than inventing. With no
  // accounts document (no key, or PDF-only), every financial line abstains at R4.
  const extractedLines = extracted?.lines ?? [];
  const visionFigures = vision?.figures ?? [];
  if (visionFigures.length > 0) {
    // The scan path. Each figure lands under the fiscal year it was read from, so leverage and
    // cover only ever combine base lines of the same year. The maturity split is enabled here
    // and nowhere else: this is the only source that reads borrowings as two printed lines.
    const filingUrl = `${url}/filing-history`;
    landFinancialLines(
      facts,
      visionFigures,
      pk,
      (fig, periodKey) => visionFact(fig, periodKey, filingUrl),
      DERIVED_WITH_BORROWINGS_SPLIT
    );
  } else if (extractedLines.length > 0) {
    // Each line lands under its own fiscal year, so leverage / cover only combine same-year
    // base facts and a base line from another period abstains rather than mixing years.
    landFinancialLines(facts, extractedLines, pk, (line, periodKey) => reportedFinancialFact(line, periodKey, url));
  }
  // Every base line the reader attempted and could not read is landed as an R4 abstention
  // carrying its reason, so a missing figure always says why rather than simply not appearing.
  if (vision) {
    const filingDescription = filing
      ? `${filing.accountsType} accounts made up to ${filing.madeUpDate ?? filing.filedOn}`
      : "the latest accounts filing";
    for (const a of vision.abstentions) {
      if (!facts[`${a.metric}.${pk}`]) {
        facts[`${a.metric}.${pk}`] = visionAbstainFact(a.metric, a.label, pk, a.reason, filingDescription);
      }
    }
  }
  // The same for the text layer: a line whose rows were all refused says why, not just "missing".
  if (textAbstentions.length > 0) {
    const filingDescription = filing
      ? `${filing.accountsType} accounts made up to ${filing.madeUpDate ?? filing.filedOn}`
      : "the latest accounts filing";
    for (const a of textAbstentions) {
      if (!facts[`${a.metric}.${pk}`]) {
        facts[`${a.metric}.${pk}`] = textAbstainFact(a.metric, a.label, pk, a.reason, filingDescription);
      }
    }
  }
  // Explicitly abstain the headline P&L / leverage metrics that were not resolved. A
  // filleted or micro filing carries a balance sheet but no P&L, so turnover / EBITDA /
  // cover render as "Not disclosed" (R4) alongside the real balance-sheet facts, never a
  // silent gap and never a guess.
  const headline: [string, string, "currency" | "ratio", string][] = [
    ["turnover", "Turnover", "currency", "GBP"],
    ["ebitda", "EBITDA", "currency", "GBP"],
    // Both net debts, the sheet leading with the one including leases (WP-BE23).
    ["netDebtIncludingLeases", "Net debt including leases", "currency", "GBP"],
    ["netDebt", "Net debt excluding leases", "currency", "GBP"],
    ["leverage", "Net leverage", "ratio", "x"],
    ["interestCover", "Interest cover", "ratio", "x"],
  ];
  for (const [metric, label, kind, unit] of headline) {
    if (!facts[`${metric}.${pk}`]) {
      facts[`${metric}.${pk}`] = abstainFinancialFact(metric, label, pk, kind, unit);
    }
  }

  const entity: EntityMeta = {
    companyName: profile.company_name,
    companyNumber: number,
    jurisdiction: profile.jurisdiction ?? "",
    status: profile.company_status ?? "",
    incorporatedOn: profile.date_of_creation ?? "",
    sicCodes: sic,
    registeredOffice: formatAddress(profile.registered_office_address),
    // The resolver's vocabulary, not the old three-way guess that called a group filing
    // "filleted" (audit finding 8). The filing's own description wins when the resolver picked
    // one, because the profile's last_accounts.type can lag an amended filing.
    accountsType:
      filing && filing.accountsType !== "unknown" ? filing.accountsType : accountsTypeLabel(profile),
    latestPeriodEnd: profile.accounts?.last_accounts?.made_up_to ?? "",
    synthetic: false,
  };

  const sources: Record<string, SourceDocument> = {
    [REGISTER_SOURCE]: {
      sourceId: REGISTER_SOURCE,
      tag: "Reg",
      documentName: "Companies House public register (structured record)",
      retrievedAt: today(),
      origin: url,
    },
  };
  if ((charges.items ?? []).length > 0) {
    sources[CHARGES_SOURCE] = {
      sourceId: CHARGES_SOURCE,
      tag: "NF",
      documentName: "Companies House charges register",
      retrievedAt: today(),
      origin: `${url}/charges`,
    };
  }
  if (extractedLines.length > 0 || goingConcernLanded) {
    sources[ACCOUNTS_SOURCE] = {
      sourceId: ACCOUNTS_SOURCE,
      tag: "Acc",
      documentName: "Annual accounts (iXBRL, Companies House filing)",
      retrievedAt: today(),
      origin: url,
    };
  }
  if (visionFigures.length > 0 || capitalStructure?.status === "found") {
    const made = filing?.madeUpDate ? ` made up to ${filing.madeUpDate}` : "";
    sources[VISION_SOURCE] = {
      sourceId: VISION_SOURCE,
      tag: "Acc",
      documentName: `Annual accounts (scanned PDF${made}, read page by page by a vision model${
        visionRead?.model ? `: ${visionRead.model}` : ""
      })`,
      retrievedAt: today(),
      origin: `${url}/filing-history`,
    };
  }
  if (insolvencyLanded) {
    sources[INSOLVENCY_SOURCE] = {
      sourceId: INSOLVENCY_SOURCE,
      tag: "Reg",
      documentName: "Companies House insolvency record (structured)",
      retrievedAt: today(),
      origin: `${url}/insolvency`,
    };
  }

  const manifest: FactManifest = { entity, facts, sources, generatedAt: today() };
  if (capitalStructure) manifest.capitalStructure = capitalStructure;
  return manifest;
}

// How a caller may use the paid vision reader.
//   auto        read the scan, paying for a model call when the filing is not cached.
//   cache-only  serve a cached read or abstain. Universe screening and any other fan-out runs
//               here, so a sweep of fifty members can never spend (audit BE-18).
//   off         never read a scan at all.
export type VisionMode = "auto" | "cache-only" | "off";

export interface BuildLiveOptions {
  vision?: VisionMode; // default "auto"
  verifier?: VisionVerifier; // default: the double read (lib/vision/verify.ts DoubleReadVerifier)
  // The second read of the debt note (WP-BE16). Default: DebtNoteFacilityReader on the same provider
  // and cache as the verifier. Null means no facilities table is read, and the sheet says so.
  facilityReader?: FacilityReader | null;
  onStage?: StageCallback;
  // Provider and cache for the vision reader. Tests inject a mock provider here; WP-BE06's run
  // job can inject its own cache. Left out, the env-configured provider and the shared cache
  // are used, exactly as readScannedAccounts would.
  visionDeps?: VisionDeps;
}

// Report a stage. A progress display must never be able to fail a run, so a callback that
// throws is swallowed here.
function stageReporter(onStage?: StageCallback) {
  return (stage: ManifestStage, status: "start" | "done" | "skipped" | "failed", detail: string): void => {
    if (!onStage) return;
    try {
      onStage({ stage, status, detail, at: new Date().toISOString() });
    } catch {
      /* a progress display cannot fail a run */
    }
  };
}

// Read a scanned filing: the model call (or the cached read), then the verifier, then the
// mapping to engine lines. The read is cached by the filing's transaction id, so a second run
// on the same filing makes no call, and a screen running cache-only makes none at all.
// Exported so the UK eval gate (eval/gold/uk-run.ts) replays the same function production runs.
export async function readVision(
  bytes: Uint8Array,
  selected: SelectedFilingDocument,
  number: string,
  pageCount: number,
  mode: VisionMode,
  verifier: VisionVerifier,
  stage: ReturnType<typeof stageReporter>,
  deps: VisionDeps = {},
  facilityReader: FacilityReader | null = null
): Promise<{ lines: VisionLines; read: VisionReadResult; capitalStructure: CapitalStructure | null }> {
  stage("extract", "start", `scanned accounts, ${pageCount} pages, ${mode === "cache-only" ? "cache only" : "live"}`);
  const read = await readScannedAccounts(
    {
      pdfBytes: bytes,
      transactionId: selected.filing.transactionId,
      companyNumber: number,
      pageCount,
    },
    { ...deps, cacheOnly: mode === "cache-only" }
  );
  const found = Object.values(read.lines).filter((l) => l.status === "found").length;
  stage(
    "extract",
    read.outcome === "read" || read.fromCache ? "done" : "skipped",
    `${read.outcome}${read.fromCache ? " (cached, no model call)" : ""}, ${found} base lines read`
  );

  stage("verify", "start", verifier.name);
  // The resolver's accounts type goes to the verifier and the landing rule: on group accounts a
  // figure must sit in the group's statements, not the parent company's own (WP-BE18).
  const accountsType = selected.filing.accountsType;
  // The debt note's second read runs beside the line verifier, not after it: both need only the
  // first read, and a large filing has no time to spare against its 90 s budget (WP-BE18).
  const facilitiesPromise: Promise<CapitalStructure | null> = facilityReader
    ? facilityReader
        .read({ read, pdfBytes: bytes, accountsType })
        .then((r) => r.table)
        .catch(() => abstainTable(read, "The second read of the debt note failed, so no facility is shown. A cell seen by one read only is never shown."))
    : Promise.resolve(null);
  let [verification, capitalStructure] = await Promise.all([
    verifier.verify({ read, pdfBytes: bytes, pageCount, accountsType }).catch(() => null),
    facilitiesPromise,
  ]);
  if (!verification) {
    // A verifier that fails must not silently pass the read: fall back to the pass-through,
    // which tags every line unverified, and an unverified line never surfaces.
    verification = await passThroughVerifier.verify({ read, pdfBytes: bytes, pageCount });
    stage("verify", "failed", `${verifier.name} failed; no scanned figure is shown without a second read`);
  } else {
    const rejected = Object.keys(verification.overrides).length;
    const agreed = Object.values(verification.lines).filter((l) => l.tag === "verified").length;
    stage("verify", "done", `${verifier.name}, ${agreed} line(s) agreed by two reads, ${rejected} abstained`);
  }
  const applied = applyVerification(read, verification);
  if (capitalStructure) {
    const shown = capitalStructure.rows.filter((r) => r.status === "found").length;
    stage("verify", "done", `debt note: ${capitalStructure.status === "found" ? `${shown} of ${capitalStructure.rows.length} facilities agreed by two reads` : `no facilities table (${capitalStructure.reason})`}`);
  }
  return {
    lines: visionLines(applied.read, applied.tags, selected.filing.madeUpDate, { accountsType }),
    read: applied.read,
    capitalStructure,
  };
}

export async function buildLiveFactManifest(
  number: string,
  options: BuildLiveOptions = {}
): Promise<FactManifest> {
  const visionMode: VisionMode = options.vision ?? "auto";
  // The double read is the default; VISION_SECOND_READ=ocr makes the second read local OCR, and
  // VISION_SECOND_READ=hybrid reads with OCR first and pays for the model only where OCR abstains
  // (WP-OCR2, WP-OCR3). A cache-only run gets a cache-only verifier, so a screen can no more pay for a
  // second read than for a first.
  const verifier =
    options.verifier ??
    createVisionVerifier({
      provider: options.visionDeps?.provider,
      cache: options.visionDeps?.cache,
      cacheOnly: visionMode === "cache-only",
    });
  // A caller that injects its own verifier (a test's scripted checker) gets no facilities read
  // unless it injects a reader too, so a scripted run can never make an unscripted call.
  const facilityReader =
    options.facilityReader !== undefined
      ? options.facilityReader
      : options.verifier
        ? null
        : new DebtNoteFacilityReader({
            provider: options.visionDeps?.provider,
            cache: options.visionDeps?.cache,
            cacheOnly: visionMode === "cache-only",
          });
  const stage = stageReporter(options.onStage);
  stage("resolve", "start", `Companies House number ${number}`);
  // Insolvency is a cited distress source; a fetch failure must never block the sheet, but it must
  // ALSO never be mistaken for "no cases on the register". getInsolvency() already returns null on
  // a 404 (a genuine empty answer) and throws on a real fetch error, so we keep that distinction:
  // a thrown error is captured as a fetch failure and threaded through, rather than swallowed to
  // null, so the mapper records an honest "could not check" gap instead of a fabricated clean-empty.
  const [profile, charges, insolvencyOutcome] = await Promise.all([
    getProfile(number),
    getCharges(number),
    getInsolvency(number)
      .then((value) => ({ value, fetchFailed: false }))
      .catch(() => ({ value: null as InsolvencyResult | null, fetchFailed: true })),
  ]);
  const insolvency = insolvencyOutcome.value;
  const insolvencyFetchFailed = insolvencyOutcome.fetchFailed;
  // Which accounts filing to read, from the resolver. A company that has filed no accounts, or
  // whose document metadata cannot be read, leaves every financial line to abstain.
  let selected: SelectedFilingDocument | null = null;
  let filingFetchFailed: string | null = null;
  try {
    selected = await selectAccountsDocument(number);
  } catch (e) {
    selected = null;
    filingFetchFailed = e instanceof Error ? e.message : String(e);
  }
  if (filingFetchFailed) {
    stage("resolve", "failed", `the filing history could not be fetched (${filingFetchFailed}), so no accounts were read; this is an outage, not an empty register`);
  } else if (selected) {
    stage(
      "resolve",
      "done",
      `${selected.filing.type} ${selected.filing.accountsType} accounts made up to ${
        selected.filing.madeUpDate ?? "an unstated date"
      }, filed ${selected.filing.filedOn}`
    );
  } else {
    stage("resolve", "done", "no accounts filing on the register, or its document could not be read");
  }

  // Best-effort: read financial base lines from the accounts iXBRL when available. Any
  // failure (no filing, PDF-only, unparseable) leaves financials to abstain, never invent.
  // We also retain the raw accounts text so the going-concern text heuristic can scan it.
  let extracted: ExtractedFinancials | undefined;
  let accountsText: string | null = null;
  let vision: VisionLines | null = null;
  let visionRead: VisionReadResult | null = null;
  let capitalStructure: CapitalStructure | null = null;
  let textAbstentions: PdfAbstention[] = [];

  if (selected?.contentUrl && selected.formats.ixbrl) {
    stage("fetch", "start", "inline XBRL accounts");
    try {
      const xml = await getLatestAccountsIxbrl(number, selected);
      if (xml) {
        accountsText = xml;
        extracted = extractFinancials(xml) ?? undefined;
      }
      stage("fetch", "done", xml ? `${xml.length} characters of inline XBRL` : "no inline XBRL document");
      stage("extract", "done", `${extracted?.lines.length ?? 0} base lines from filer tags`);
    } catch {
      extracted = undefined;
      stage("fetch", "failed", "the inline XBRL document could not be fetched");
    }
  }

  // PDF filers, which is most of the UK register. Fetch the PDF once, then decide what it is:
  //   a genuine text layer -> the deterministic extractor, free and exact.
  //   a scan               -> the vision reader, page by page (audit findings 13 and 17).
  // OCR stays as the middle path for anyone who has configured a provider.
  if (!extracted && selected?.contentUrl && selected.formats.pdf) {
    stage("fetch", "start", "PDF accounts");
    try {
      const bytes = await fetchPdfBytes(selected.contentUrl, authHeader());
      if (bytes) {
        const pageCount = selected.pageCount > 0 ? selected.pageCount : await countPdfPages(bytes);
        // A PDF that declares no font is a scan whatever its text says (classifyPdf's first test),
        // so its text layer is not extracted. On a 200-page scan that took 39 to 71 s, past the 30 s
        // fetch slice, and the run died in fetch before a page was read (Bellis Finco, WP-BE14-LIVE-2).
        const text = pdfDeclaresFont(bytes) ? await pdfToText(bytes) : "";
        const kind: PdfKind = classifyPdf(bytes, text, pageCount);
        stage("fetch", "done", `${(bytes.length / 1024 / 1024).toFixed(1)} MB, ${pageCount} pages, ${kind}`);

        if (kind === "text-layer") {
          stage("extract", "start", "PDF text layer");
          if (text && text.length >= 40 && !accountsText) accountsText = text;
          // The resolver's label goes in so a group filing is held to the basis check (WP-GRPCHK).
          const pdf = extractFinancialsFromText(text, "pdf", { accountsType: selected.filing.accountsType });
          if (pdf && pdf.lines.length > 0) {
            extracted = textLayerExtraction(pdf, selected.filing.madeUpDate ?? null, profile);
          }
          textAbstentions = pdf?.abstentions ?? [];
          stage("extract", "done", `${pdf?.lines.length ?? 0} base lines from the text layer`);
        } else if (visionMode === "off") {
          stage("extract", "skipped", "a scan, and this run may not read scans");
        } else {
          const result = await readVision(
            bytes,
            selected,
            number,
            pageCount,
            visionMode,
            verifier,
            stage,
            options.visionDeps,
            facilityReader
          );
          vision = result.lines;
          visionRead = result.read;
          capitalStructure = result.capitalStructure;
          // A scan with an OCR provider configured can still feed the going-concern text scan.
          if (!accountsText) {
            const provider = await getOcrProvider().catch(() => null);
            if (provider) accountsText = await ocrPdf(bytes, provider).catch(() => null);
          }
        }
      } else {
        stage("fetch", "failed", "the PDF document could not be fetched");
      }
    } catch {
      stage("fetch", "failed", "the PDF document could not be read");
    }
  }

  stage("assemble", "start", "fact manifest");
  const manifest = mapLiveToManifest(profile, charges, {
    extracted,
    insolvency,
    accountsText,
    insolvencyFetchFailed,
    filingFetchFailed: filingFetchFailed !== null,
    vision,
    visionRead,
    filing: selected?.filing ?? null,
    capitalStructure,
    textAbstentions,
  });
  // Best-effort LEI enrichment (free GLEIF, cached 30 days, never blocks the sheet):
  // deterministic by the CH number, so a wrong link cannot creep in.
  try {
    const lei = await resolveLei(profile.company_name, { chNumber: number, withParents: true });
    if (lei) {
      manifest.entity.lei = lei.lei;
      manifest.entity.ultimateParentLei = lei.ultimateParentLei;
    }
  } catch {
    /* LEI is enrichment, not required */
  }
  stage("assemble", "done", `${Object.keys(manifest.facts).length} facts`);
  return manifest;
}

// ---------------------------------------------------------------------------
// Pseudo-fixture so the LIVE manifest renders through the existing assemble pipeline.
// assembleTearSheet reads only periods, thesis and capitalStructure off the fixture;
// everything else it needs comes from the manifest.
// ---------------------------------------------------------------------------

// Say what the sheet actually is. Since WP-BE04 the financial lines are read, so the old line
// ("financial lines abstain until a parser is connected") would be false on a sheet showing
// figures (audit finding 30). What has to stay honest is HOW they were read: a scan carries no
// quotable text, so each figure cites a page and the characters printed on it, with the
// verification tag the checker gave it.
const LIVE_THESIS =
  "Live Companies House record. Structured fields (sector, incorporation, accounts dates, geography, secured charges) resolve at R1 from the register. Financial lines come from the accounts filing the resolver picked: filer tags where the filing is inline XBRL, otherwise the scanned pages read one by one. A figure read from a scan is cited by PDF page, printed label, the figure exactly as printed and its scale caption, not by quotation, because a scan has no text to quote. Anything not printed abstains with its reason.";

export function mapLiveToFixture(
  profile: CompanyProfile,
  charges: ChargesList,
  manifest: FactManifest
): BorrowerFixture {
  const period = livePrimaryPeriod(profile);
  const items = charges.items ?? [];
  return {
    key: profile.company_number,
    displayName: profile.company_name,
    thesis: LIVE_THESIS,
    profile,
    filingHistory: { items: [], total_count: 0 },
    charges,
    sources: manifest.sources,
    periods: [period],
    reported: [],
    // Registered charges are charges, from the charges register. The register records security,
    // not ranking, and nothing on it says where value breaks, so no charge carries a rank or a
    // fulcrum (audit finding 7). Ranking, where a note states it, is on the facilities table.
    capitalStructure: items.map((charge) => ({
      id: `charge-${charge.charge_number}`,
      name: charge.classification?.description ?? "Registered charge",
      rank: "not-stated" as const,
      metric: chargeMetric(charge),
      security: charge.secured_details?.description ?? "Registered charge",
      provider: chargeeName(charge),
      isFulcrum: false,
    })),
    derivedMetrics: [],
  };
}

// Assemble the tear sheet AND return the underlying manifest, so the /live route can
// persist the FactManifest to the tenant workspace as a side effect of rendering.
export async function assembleLive(
  number: string,
  options: BuildLiveOptions = {},
): Promise<{ ts: TearSheet; manifest: FactManifest }> {
  // Use the FULL builder so live sheets get the same treatment as SEC/ESEF: accounts iXBRL/PDF
  // extraction (+ optional OCR) and GLEIF LEI enrichment, not just the structured CH fields.
  // profile/charges are fetched again only to shape the fixture's period + capital structure;
  // both calls are cached, so this does not double the network cost.
  const manifest = await buildLiveFactManifest(number, options);
  const [profile, charges] = await Promise.all([getProfile(number), getCharges(number)]);
  const fixture = mapLiveToFixture(profile, charges, manifest);
  return { ts: assembleTearSheet(manifest, fixture), manifest };
}

export async function assembleLiveTearSheet(number: string, options: BuildLiveOptions = {}): Promise<TearSheet> {
  return (await assembleLive(number, options)).ts;
}

// Gate helper for the UI: is the live path configured?
export function liveConfigured(): boolean {
  return typeof process !== "undefined" && !!process.env.CH_API_KEY;
}
