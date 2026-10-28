// lib/resolve/types.ts
// Shapes shared by the resolver. The Ch* interfaces are the parts of the Companies House
// responses the resolver reads. Every field is optional where the register may omit it.

import type { AccountsTypeLabel } from "./accountsType";

export interface ChAddress {
  locality?: string;
  postal_code?: string;
  address_line_1?: string;
  country?: string;
}

// One row of GET /search/companies. `snippet` lists previous names that matched, joined by " · ".
export interface ChSearchItem {
  company_number: string;
  title: string;
  company_status?: string;
  company_type?: string;
  date_of_creation?: string;
  date_of_cessation?: string;
  address?: ChAddress;
  address_snippet?: string;
  snippet?: string;
  description?: string;
}

export interface ChSearchResult {
  items?: ChSearchItem[];
  total_results?: number;
}

export interface ChPreviousName {
  name: string;
  effective_from?: string;
  ceased_on?: string;
}

// GET /company/{number}, the fields the resolver reads.
export interface ChProfile {
  company_name: string;
  company_number: string;
  company_status?: string;
  type?: string;
  jurisdiction?: string;
  date_of_creation?: string;
  date_of_cessation?: string;
  registered_office_address?: ChAddress;
  accounts?: {
    last_accounts?: { made_up_to?: string | null; type?: string | null };
    next_due?: string;
    overdue?: boolean;
  };
  previous_company_names?: ChPreviousName[];
}

// One row of GET /company/{number}/filing-history?category=accounts.
export interface ChFilingItem {
  transaction_id: string;
  category?: string;
  type: string; // "AA", "AAMD", "AA01", ...
  description?: string; // e.g. "accounts-with-accounts-type-group"
  description_values?: { made_up_date?: string; [key: string]: unknown };
  date: string; // the date Companies House received the filing
  action_date?: string;
  pages?: number;
  paper_filed?: boolean;
  links?: { self?: string; document_metadata?: string };
}

// Everything the resolver needs from the outside world. Tests inject a fixture-backed client.
export interface ResolveClient {
  search(q: string): Promise<ChSearchResult>;
  // null when the register has no company with this number (a 404).
  profile(number: string): Promise<ChProfile | null>;
  // Every accounts-category filing, newest first as Companies House returns them.
  filingHistory(number: string): Promise<ChFilingItem[]>;
  // The LEI registered against this Companies House number, or null.
  leiForCompanyNumber(number: string): Promise<string | null>;
}

export type MatchKind = "exact" | "compact" | "previous-name" | "contains";

export interface EsefHint {
  lei: string;
}

export interface Candidate {
  number: string;
  name: string;
  status: string; // "active", "liquidation", "dissolved", ...
  type: string; // "ltd", "plc", "llp", ...
  incorporatedOn: string | null;
  locality: string | null;
  // null when the profile was not read (only happens if the profile call failed).
  lastAccounts: { madeUpTo: string | null; type: AccountsTypeLabel } | null;
  previousNames: string[];
  // How the name matched. Absent for a number input, which needs no name match.
  match?: MatchKind;
  // The previous name that matched, when the match was on a previous name.
  matchedPreviousName?: string;
  // true or false once the accounts filing history was read; null when it was not checked.
  hasAccountsFiling: boolean | null;
  // Plain reasons for where this candidate ranked, in the order they were applied.
  why: string[];
  esef?: EsefHint;
}

export type ResolveResult =
  | { kind: "resolved"; company: Candidate; reason: string; esef?: EsefHint }
  | { kind: "pick"; candidates: Candidate[]; suggested: string; reason: string }
  | { kind: "none"; reason: string }
  | { kind: "excluded"; reason: string; number?: string };
