// lib/vision/types.ts
// Shared types for reading scanned Companies House accounts with a vision model.
//
// A read returns every base line either as a figure exactly as printed (with its page,
// scale caption, statement and period) or as an abstention with a reason. Nothing here
// is a computed number. Wiring into the sheet path is WP-BE04's job.

import type { LLMUsage } from "../llm/types";
import type { AccountsTypeLabel } from "../resolve/accountsType";

export const BASE_LINE_KEYS = [
  "turnover",
  "operating_profit",
  "depreciation_amortisation",
  "interest_payable",
  "profit_before_tax",
  "cash_at_bank",
  "borrowings_within_one_year",
  "borrowings_after_one_year",
  // WP-BE23: one lease key carried two meanings (the engine read the total, the gold set the
  // non-current line). It is split into three named lines. docs/decisions/2026-09-24-lease-
  // liabilities-confirmed.md.
  "lease_liabilities_total",
  "lease_liabilities_current",
  "lease_liabilities_non_current",
  "preference_shares",
  "shareholder_loans",
  "net_assets",
  "total_assets",
  "current_liabilities",
  // UK Companies Act balance sheets print this line themselves, as "Net current assets" or
  // "Net current liabilities". It is read, never worked out from current assets less current
  // liabilities (audit BE-17).
  "net_current_liabilities",
] as const;
export type BaseLineKey = (typeof BASE_LINE_KEYS)[number];

export interface FoundLine {
  status: "found";
  printedLabel: string | null;
  figureText: string; // characters as printed, brackets included
  value: number; // the printed figure in printed units; the scale is NOT applied
  sign: "positive" | "negative";
  scaleCaption: string; // e.g. "£'000", "£m"
  pdfPageIndex: number; // position in the PDF file, first page = 1
  printedPageNumber: string | null;
  statement: string;
  periodEnd: string; // YYYY-MM-DD
  noteReference: string | null;
}

export interface AbstainLine {
  status: "abstain";
  reason: string;
}

export type VisionLine = FoundLine | AbstainLine;

export const FACILITY_TYPES = [
  "term_loan",
  "revolving_credit_facility",
  "notes_or_bonds",
  "overdraft",
  "shareholder_loan",
  "lease",
  "other",
] as const;
export type FacilityType = (typeof FACILITY_TYPES)[number];

// Every field may be null, which is that field abstaining.
export interface Facility {
  nameAsPrinted: string | null;
  type: FacilityType | null;
  lender: string | null;
  amountDrawnText: string | null;
  amountDrawnValue: number | null;
  facilitySizeText: string | null;
  facilitySizeValue: number | null;
  currency: string | null;
  maturity: string | null; // a date or a bucket, as printed
  rateOrMargin: string | null;
  security: string | null;
  ranking: string | null;
  pdfPageIndex: number | null;
}

export interface MaturityBucket {
  bucketAsPrinted: string | null;
  amountText: string | null;
  amountValue: number | null;
  pdfPageIndex: number | null;
}

export type DebtNote =
  | {
      status: "found";
      scaleCaption: string | null;
      pdfPageIndexes: number[];
      facilities: Facility[];
      maturityBuckets: MaturityBucket[];
    }
  | { status: "abstain"; reason: string };

export interface VisionDocumentMeta {
  companyNameAsPrinted: string | null;
  periodEnd: string | null;
  currency: string | null;
  basis: "consolidated" | "company" | null;
}

export interface VisionReadInput {
  pdfBytes: Uint8Array;
  transactionId: string; // the CH filing transaction id, the stable cache handle
  companyNumber: string;
  pageCount: number; // from CH filing history metadata
}

export type VisionOutcome =
  | "read" // the model answered and the output validated
  | "too-large" // over the PDF page or size limit, no call made
  | "unconfigured" // no model id or key, no call made
  | "cache-miss" // a cache-only read found nothing cached, no call made
  | "model-failure" // refusal, max_tokens, timeout, HTTP or network failure
  | "malformed"; // the output did not validate against the schema

// Abstain reasons the client sets itself (the model supplies its own for "read" outcomes).
export const ABSTAIN = {
  tooLarge: "too-large-needs-page-finding",
  unconfigured: "llm-unconfigured",
  malformed: "malformed-output",
  incomplete: "incomplete-found-line",
  mismatch: "figure-text-value-mismatch",
  pageOutOfRange: "page-out-of-range",
  noReason: "abstained-without-reason",
  noFacilities: "no-facilities-read",
  notReturned: "line-not-returned",
  cacheOnly: "cache-only-no-model-call",
  noScale: "scale-caption-not-understood",
} as const;

export interface VisionReadResult {
  outcome: VisionOutcome;
  fromCache: boolean; // true means no model call was made for this result
  cacheKey: string;
  schemaVersion: number;
  promptVersion: string;
  model: string | null;
  transactionId: string;
  companyNumber: string;
  pageSet: string; // "all" until WP-BE15 sends page subsets
  document: VisionDocumentMeta;
  lines: Record<BaseLineKey, VisionLine>;
  debtNote: DebtNote;
  usage: LLMUsage | null; // this call's usage; null when no call was made
  recordedUsage: LLMUsage | null; // on a cache hit, the usage of the call that produced it
  failure?: { kind: string; detail: string };
}

// ---------------------------------------------------------------------------
// The verifier seam (WP-BE05 implements it, WP-BE06 calls it)
// ---------------------------------------------------------------------------
//
// A scanned filing carries no text layer, so the Citations API returns nothing and the
// doctrine guard in lib/llm/extract.ts (drop any figure whose quote is not in the document
// text) cannot run (audit finding 19). Verification of a scan is therefore a second opinion
// on the same page, not a string match, and it is a separate step so that it can be a
// different model, a different prompt, or no step at all.
//
// THE CONTRACT. A verifier:
//   - MAY confirm a found line ("verified"), leave it alone ("unverified"), or reject it by
//     returning an override, which turns that line into an abstention.
//   - MAY read the same PDF bytes and make its own model calls, and MUST report their usage.
//   - MUST NOT change any digit, page, scale caption, statement, period or sign of a found
//     line. A verifier that disagrees abstains the line; it never rewrites it.
//   - MUST NOT turn an abstention into a figure. A line the reader did not read cannot be
//     supplied by the checker.
//   - MUST return a tag for every base line key, so a line that was never looked at says so
//     ("not-checked") rather than passing silently as verified.
//   - MUST be deterministic in its effect on the caller: the same read and the same bytes
//     give the same overrides, so a cached read plus a cached verification is reproducible.
//
// Since WP-BE05 "verified" is not enough on its own. A found line reaches the sheet only when its
// tag carries DoubleReadEvidence that matches the line (lib/vision/verify.ts doubleReadProblem,
// called by lib/sources/visionAccounts.ts). Anything else, including "unverified", abstains.

export type VerificationTag =
  | "unverified" // no verifier ran, or it declined to express a view
  | "verified" // a second look agreed with the printed figure, page and scale
  | "rejected" // a second look disagreed; the line is abstained, never corrected
  | "not-checked"; // this line was outside what the verifier looked at

export interface VerifiedLine {
  tag: VerificationTag;
  note: string | null; // one short plain line, shown on the evidence card
  // What a "verified" tag rests on. Since WP-BE05 a found line surfaces only when this is a
  // double read that agrees with the line (lib/sources/visionAccounts.ts checks it again), so a
  // verifier that says "verified" without showing its second read has verified nothing.
  evidence?: DoubleReadEvidence;
}

// ---------------------------------------------------------------------------
// The double read (WP-BE05)
// ---------------------------------------------------------------------------

// What the second read saw for one line, on the pages the first read cited.
export interface SecondReadFigure {
  printedLabel: string | null;
  figureText: string;
  value: number; // printed units, signed as printed; no scale applied
  scaleCaption: string; // the caption the second read gave for the figure
  headerScaleCaption: string | null; // the caption printed at the head of the statement or column
  currency: string | null; // ISO code the header establishes, e.g. "GBP"
  columnHeading: string | null; // the column heading as printed, e.g. "2026" or "31 March 2026"
  // The header rows of the same table above the column heading, nearest first, at most two
  // (WP-BE22). Absent on a second read recorded before WP-BE22.
  headerRowsAbove?: string[];
  // Where the period was established from: the column heading, or, when that prints no year, a
  // header row above it (WP-BE22). The citation says which, so a reader can see where it came from.
  periodSource?: PeriodSource;
  periodEnd: string; // YYYY-MM-DD
  pdfPageIndex: number; // mapped back to the ORIGINAL filing's page index
  statement: string | null;
}

export type PeriodSource =
  | { from: "column-heading"; text: string }
  | { from: "header-row"; text: string; columnHeading: string; rowsRead: string[] };

export type TieStatus = "pass" | "fail" | "not-run";

// An arithmetic identity printed on the page, run on the figures. A tie that cannot run (a
// side is not printed, or not agreed) is "not-run", never a failure.
export interface TieResult {
  id: string; // e.g. "balance-sheet.net-assets-equity"
  label: string; // plain words, e.g. "Balance sheet: net assets equal total equity"
  status: TieStatus;
  detail: string; // the arithmetic, or why it did not run
  outBy: number | null; // pounds, when it failed
  lines: BaseLineKey[]; // the base lines this tie confirms or condemns
}

export interface DoubleReadEvidence {
  kind: "double-read";
  verifier: string;
  first: { figureText: string; value: number; scaleCaption: string; periodEnd: string; pdfPageIndex: number };
  second: SecondReadFigure;
  scale: number; // the multiplier both reads and the statement header agree on
  pounds: number; // the agreed figure in pounds, printed sign kept
  ties: TieResult[]; // every tie this line took part in that passed or could not run
  // Set when the filing is group accounts and the basis check ran and passed (WP-BE18): both reads
  // said consolidated, and `heading` is the printed group heading that established it.
  basis?: BasisEvidence;
}

export interface BasisEvidence {
  first: "consolidated"; // the first read's document basis
  second: "consolidated"; // the second read's basis for this line, found on the page itself
  heading: string; // the printed words that say consolidated or group, e.g. "Group balance sheet"
}

export interface VisionVerifyInput {
  read: VisionReadResult;
  pdfBytes: Uint8Array;
  pageCount: number;
  // The resolver's accounts type for the filing read (lib/resolve/accountsType.ts). "group" turns
  // on the basis check (WP-BE18); anything else, or nothing, leaves it off.
  accountsType?: AccountsTypeLabel | null;
}

export interface VisionVerifyResult {
  verifier: string; // name and version of whatever ran, e.g. "pass-through/v1"
  lines: Record<BaseLineKey, VerifiedLine>;
  // Lines the verifier rejected, with the reason that replaces the figure. Any key here must
  // also carry the "rejected" tag above.
  overrides: Partial<Record<BaseLineKey, AbstainLine>>;
  usage: LLMUsage | null; // null when the verifier made no model call
}

export interface VisionVerifier {
  readonly name: string;
  verify(input: VisionVerifyInput): Promise<VisionVerifyResult>;
}

// ---------------------------------------------------------------------------
// Stage callbacks (WP-BE06's run job shows these)
// ---------------------------------------------------------------------------

export const MANIFEST_STAGES = ["resolve", "fetch", "extract", "verify", "assemble"] as const;
export type ManifestStage = (typeof MANIFEST_STAGES)[number];

export interface StageEvent {
  stage: ManifestStage;
  // "skipped" is a real outcome, not a failure: a filing with iXBRL skips the vision extract,
  // and a run with no verifier skips verify.
  status: "start" | "done" | "skipped" | "failed";
  detail: string; // one plain line, safe to show a user; never a key or a header
  at: string; // ISO instant
}

// Never throws into the builder: a callback that throws is swallowed by the caller, because a
// progress display must not be able to fail a run.
export type StageCallback = (event: StageEvent) => void;
