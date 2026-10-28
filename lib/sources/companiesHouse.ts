// lib/sources/companiesHouse.ts
// REAL Companies House REST connector. Calls the live Companies House Public Data API
// (https://api.company-information.service.gov.uk) using an API key read from the
// CH_API_KEY environment variable. Types below match the real API response shapes.
//
// The connector is GATED: if no CH_API_KEY is present the app runs entirely on the
// bundled fixtures, which conform to these same types. When a key is added the app
// "flips" to live data with no other change. This is the ready-to-flip claim.

const CH_BASE = "https://api.company-information.service.gov.uk";

// --- Real API response types (subset used by the tear sheet) -----------------

export interface RegisteredOfficeAddress {
  address_line_1?: string;
  address_line_2?: string;
  locality?: string;
  region?: string;
  postal_code?: string;
  country?: string;
}

export interface CompanyAccountsPeriod {
  made_up_to?: string;
  period_start_on?: string;
  period_end_on?: string;
  type?: string; // e.g. "full", "small", "micro-entity", "group"
}

export interface CompanyAccounts {
  accounting_reference_date?: { day: string; month: string };
  last_accounts?: CompanyAccountsPeriod;
  next_accounts?: CompanyAccountsPeriod & { due_on?: string; overdue?: boolean };
  next_due?: string;
  overdue?: boolean;
}

export interface CompanyProfile {
  company_name: string;
  company_number: string;
  company_status: string; // "active", "liquidation", ...
  date_of_creation: string;
  type: string; // "ltd", "plc", ...
  jurisdiction: string; // "england-wales", ...
  sic_codes?: string[];
  registered_office_address?: RegisteredOfficeAddress;
  accounts?: CompanyAccounts;
  has_charges?: boolean;
}

export interface FilingHistoryItem {
  transaction_id: string;
  category: string; // "accounts", "capital", "mortgage", ...
  type: string; // "AA", "MR01", ...
  description: string;
  date: string;
  paper_filed?: boolean;
  links?: { self?: string; document_metadata?: string };
}

export interface FilingHistoryList {
  items: FilingHistoryItem[];
  total_count: number;
  filing_history_status?: string;
}

export interface ChargeItem {
  charge_number: number;
  classification?: { description?: string };
  persons_entitled?: { name: string }[];
  status: string; // "outstanding", "satisfied", ...
  created_on?: string;
  secured_details?: { description?: string };
}

export interface ChargesList {
  items: ChargeItem[];
  total_count: number;
  unfiled_count?: number;
}

// --- Live-mode gate -----------------------------------------------------------

export function isLiveModeEnabled(): boolean {
  return typeof process !== "undefined" && !!process.env.CH_API_KEY;
}

function authHeader(): string {
  const key = process.env.CH_API_KEY ?? "";
  // Companies House uses HTTP Basic auth with the API key as the username and an
  // empty password.
  const token = Buffer.from(`${key}:`).toString("base64");
  return `Basic ${token}`;
}

async function chGet<T>(path: string): Promise<T> {
  if (!isLiveModeEnabled()) {
    throw new Error(
      "Companies House live mode is disabled (no CH_API_KEY). The app is running on fixtures."
    );
  }
  const res = await fetch(`${CH_BASE}${path}`, {
    headers: { Authorization: authHeader(), Accept: "application/json" },
    // Company data changes slowly; a short cache is appropriate.
    next: { revalidate: 3600 },
  } as RequestInit);
  if (res.status === 404) {
    throw new Error(`Companies House: not found for ${path}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error("Companies House: authentication failed. Check CH_API_KEY.");
  }
  if (res.status === 429) {
    throw new Error("Companies House: rate limit exceeded (600 requests / 5 min).");
  }
  if (!res.ok) {
    throw new Error(`Companies House: unexpected status ${res.status} for ${path}`);
  }
  return (await res.json()) as T;
}

// --- Public connector surface -------------------------------------------------

export function getCompanyProfile(companyNumber: string): Promise<CompanyProfile> {
  return chGet<CompanyProfile>(`/company/${encodeURIComponent(companyNumber)}`);
}

export function getFilingHistory(companyNumber: string): Promise<FilingHistoryList> {
  return chGet<FilingHistoryList>(
    `/company/${encodeURIComponent(companyNumber)}/filing-history?category=accounts&items_per_page=25`
  );
}

export function getCharges(companyNumber: string): Promise<ChargesList> {
  return chGet<ChargesList>(`/company/${encodeURIComponent(companyNumber)}/charges`);
}

export interface CompanySearchItem {
  company_number: string;
  title: string;
  company_status: string;
  company_type: string;
  address_snippet?: string;
}
export interface CompanySearchResult {
  items: CompanySearchItem[];
  total_results: number;
}

export function searchCompanies(query: string): Promise<CompanySearchResult> {
  return chGet<CompanySearchResult>(
    `/search/companies?q=${encodeURIComponent(query)}&items_per_page=20`
  );
}
