// lib/sources/fixtures/types.ts
// Contract for a bundled synthetic borrower. Each fixture carries a Companies-House
// shaped profile (so the live connector can drop straight in) plus a library of
// REPORTED (R1) facts, each with an exact source snippet. These snippets are what the
// evidence cards render. All fixture borrowers are synthetic and clearly labelled
// illustrative; they belong to no real entity.

import type {
  ChargesList,
  CompanyProfile,
  FilingHistoryList,
} from "../companiesHouse";
import type { FactValueKind, ProvenanceTag, SourceDocument } from "../../engine/types";

// A single reported figure as read from a filing. This is the raw input to the
// ladder; the ladder wraps it as an R1 Fact and everything else derives from it.
export interface RawReportedFact {
  metric: string; // canonical metric key, e.g. "operatingProfit"
  label: string; // display label, e.g. "Operating profit"
  period: string; // e.g. "FY2024"
  kind: FactValueKind;
  unit: string; // "GBP", "x", "%", "FTE"
  value: number;
  sourceId: string; // -> SourceDocument
  tag: ProvenanceTag;
  documentName: string;
  locator: string; // "Note 4, p.18"
  snippet: string; // exact text as it appears in the source
  retrievedAt: string; // ISO date
}

export interface PeriodMeta {
  key: string; // "FY2024"
  label: string; // "Year ended 31 December 2024"
  end: string; // ISO date of period end
  isLatest: boolean;
}

// One tranche of the capital structure. Amounts are Facts by metric key so each is clickable /
// cited like everything else. A synthetic fixture is ordered senior -> junior. A real filing's
// tranches carry "not-stated": a registered charge or a balance sheet total says nothing about
// ranking, so a live sheet never claims one (audit finding 7, WP-BE16).
export interface CapitalTranche {
  id: string;
  name: string; // "Senior term loan (Facility A)"
  rank: "senior-secured" | "senior" | "rcf" | "subordinated" | "equity" | "not-stated";
  metric: string; // fact metric key holding the amount, e.g. "trancheTermLoan"
  security: string; // "Fixed and floating charge over all assets"
  provider: string; // synthetic lender name
  isFulcrum: boolean; // the tranche the value is expected to break in
}

export interface BorrowerFixture {
  key: string; // "meridian"
  displayName: string; // "PROJECT MERIDIAN (illustrative)"
  redactedName?: boolean; // render the codename with a redaction bar
  thesis: string; // one line on why this borrower exists in the demo
  profile: CompanyProfile;
  filingHistory: FilingHistoryList;
  charges: ChargesList;
  sources: Record<string, SourceDocument>;
  periods: PeriodMeta[];
  reported: RawReportedFact[];
  capitalStructure: CapitalTranche[];
  // metrics the ladder should attempt to resolve beyond the reported set
  derivedMetrics: string[]; // e.g. ["ebitda", "netDebt", "leverage", "interestCover"]
}
