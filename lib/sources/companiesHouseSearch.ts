// lib/sources/companiesHouseSearch.ts
// The UNIVERSE side of Engine C. Where companiesHouseLive.ts fetches ONE company's record,
// this fetches a whole mandate universe from the Companies House Advanced Search endpoint
// (GET /advanced-search/companies) and returns a typed candidate list to screen. It mirrors
// the auth + budget-guard pattern of companiesHouseLive.ts exactly: HTTP Basic with the
// CH_API_KEY as the username, and a call to assertChBudget() before every upstream request
// (now through chHttp.ts, which also paces and retries)
// so a universe sweep can never approach CH's 600-requests-per-5-minutes ceiling.
//
// Honesty boundary: Advanced Search returns only the register header fields (name, number,
// status, SIC, incorporation date). It carries NO financials, so a candidate here is a lead
// to screen, never a scored suggestion. The scoring happens later, per member, in
// screenUniverse via the full originateForTarget path.

import { chFetchText } from "./chHttp";
import { MB } from "./fetchLimits";

const CH_BASE = "https://api.company-information.service.gov.uk";

// CH Advanced Search caps `size` at 5000 and requires at least 1. We default to a modest
// pool so a careless call does not pull thousands of rows; screenUniverse then caps how many
// of those are actually processed.
const DEFAULT_SIZE = 50;
const MAX_SIZE = 5000;

// ---------------------------------------------------------------------------
// Auth (mirrors companiesHouseLive.ts): CH_API_KEY as the Basic-auth username, empty password.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export interface UniverseQuery {
  sicCodes?: string[];
  statuses?: string[]; // e.g. "active", "liquidation"
  incorporatedFrom?: string; // YYYY-MM-DD
  incorporatedTo?: string; // YYYY-MM-DD
  location?: string;
  size?: number; // 1..5000, defaults to DEFAULT_SIZE
}

// One universe member: exactly the header fields Advanced Search supplies. No financials, so
// no score can be inferred here; screenUniverse resolves each candidate's cited catalyst.
export interface CompanyCandidate {
  chNumber: string;
  name: string;
  status: string;
  sicCodes: string[];
}

// Minimal shape of the Advanced Search response we read.
interface AdvancedSearchItem {
  company_number?: string;
  company_name?: string;
  company_status?: string;
  sic_codes?: string[];
}
interface AdvancedSearchResponse {
  hits?: number;
  items?: AdvancedSearchItem[];
}

function clampSize(size?: number): number {
  if (size === undefined || !Number.isFinite(size)) return DEFAULT_SIZE;
  return Math.max(1, Math.min(MAX_SIZE, Math.floor(size)));
}

// Build the advanced-search universe. `sic_codes` and `company_status` may repeat, so both
// go through URLSearchParams.append. Throws the same typed "CH_API_KEY not set" error the
// other CH fetchers do when the key is missing, before any network work happens.
export async function searchCompanies(query: UniverseQuery): Promise<CompanyCandidate[]> {
  const header = authHeader(); // throws the typed error if CH_API_KEY is unset

  const params = new URLSearchParams();
  for (const sic of query.sicCodes ?? []) {
    if (sic.trim()) params.append("sic_codes", sic.trim());
  }
  for (const status of query.statuses ?? []) {
    if (status.trim()) params.append("company_status", status.trim());
  }
  if (query.incorporatedFrom) params.set("incorporated_from", query.incorporatedFrom);
  if (query.incorporatedTo) params.set("incorporated_to", query.incorporatedTo);
  if (query.location) params.set("location", query.location);
  params.set("size", String(clampSize(query.size)));

  // Global budget guard, pacer and retry, exactly as the single-company path: chFetchText
  // charges assertChBudget() before every attempt and throws the typed ChBudgetError the UI
  // surfaces honestly (WP-BE14).
  const res = await chFetchText(`${CH_BASE}/advanced-search/companies?${params.toString()}`, {
    headers: { Authorization: header },
    accept: "application/json",
    maxBytes: 64 * MB,
    timeoutMs: 30_000,
  });

  if (res.status === 401 || res.status === 403) {
    throw new Error("Companies House: authentication failed. Check CH_API_KEY.");
  }
  if (res.status === 429) {
    throw new Error("Companies House: rate limit exceeded (600 requests / 5 min).");
  }
  if (!res.ok) {
    throw new Error(`Companies House: unexpected status ${res.status} for advanced-search`);
  }

  const body = JSON.parse(res.text) as AdvancedSearchResponse;
  const items = body.items ?? [];
  const candidates: CompanyCandidate[] = [];
  for (const item of items) {
    const chNumber = item.company_number?.trim();
    if (!chNumber) continue; // a row with no number cannot be screened, so drop it
    candidates.push({
      chNumber,
      name: item.company_name ?? chNumber,
      status: item.company_status ?? "",
      sicCodes: item.sic_codes ?? [],
    });
  }
  return candidates;
}

// Gate helper for the UI: is the search path configured?
export function searchConfigured(): boolean {
  return typeof process !== "undefined" && !!process.env.CH_API_KEY;
}
