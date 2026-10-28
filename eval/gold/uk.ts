// eval/gold/uk.ts
// UK gold set. Part 1 (WP-BE03, Tue 15 Sep 2026): thirteen frozen Companies House and ESEF
// filings (eval/gold/fixtures/uk/<company number>-<made-up date>/) with their first figures.
// Part 2 (WP-BE17, Tue 22 Sep 2026): at least three figures on every filing, facilities from
// the debt notes, the Bristol Water and IFRS 16 cases, structured ties (UK_TIES) and the
// provisional claude-checked label.
//
// Read this before trusting a figure. The system under test is Claude reading scanned
// accounts, and every "agent-read" figure here was also keyed by Claude, reading the same
// scans. A gold set keyed only by an agent shares its blind spots. So:
//   - agent-read figures are "candidate" (or "tie-checked" when a printed arithmetic identity
//     on the same page holds) until someone checks them.
//   - "claude-checked" is PROVISIONAL and is NOT a person's check. It marks the ten spot-check
//     figures (spotCheck 1 to 10), which two machine checks agree with: Claude's visual read of
//     each page image on Mon 21 Sep (uk/spot-check-2026-09-16.md) and a local Apple Vision OCR
//     presence test the same day (docs/deepdives/local-ocr-gold-2026-09-21.md). Cam decided on
//     Tue 22 Sep to run WP-BE17 on these while his own check is outstanding. Each such figure
//     carries both checks in `checks`, so the data says who looked, not a footnote.
//   - "cam-checked" and "cam-corrected" are reserved for Cam's own pass. No figure uses them
//     yet. When Cam does the sheet, his result replaces claude-checked on those ten figures
//     (status becomes cam-checked or cam-corrected, and a { by: "cam" } entry is appended to
//     `checks`; the machine entries stay as history). Nothing else changes.
//   - PERSON_CHECKED below is the only list of statuses that may be called checked by a person.
//     Any report, summary or claim that says a person verified figures must count with
//     isPersonChecked(), which today returns false for every figure.
//   - tag-derived figures come from iXBRL or ESEF tags through the existing extractors
//     (lib/sources/ixbrl.ts, lib/sources/esef.ts; see uk/tags.ts). No model read them.
//
// Conventions:
//   - metric names are the WP-BE01 base line keys (lib/vision/types.ts BASE_LINE_KEYS), in
//     snake_case. Where an extractor yields a line with no WP-BE01 key, the name says so
//     (borrowings_total, current_assets and so on).
//   - value is in pounds with the scale applied. For agent-read figures the sign is the
//     printed sign: brackets mean negative, so a liability printed "(12.5)" under £m is
//     -12_500_000. For tag-derived figures the value is what the extractor returns (the
//     iXBRL sign attribute applied), so costs such as finance costs are positive.
//   - pdfPage is the 1-based page index in filing.pdf, which is what Preview shows.
//     printedPage is the number printed on the page, when there is one.
//
//   - value "ABSTAIN" means the right answer for that key is to abstain, by the reader's own
//     definition (lib/vision/prompt.ts). printedText still records what is on the page.
//   - figures from a second document in the case folder (the Pret parent's accounts) name it
//     in `document`; otherwise the figure is in filing.pdf.
//   - Leases are three keys (WP-BE23, docs/decisions/2026-09-24-lease-liabilities-confirmed.md,
//     confirmed by Cam on Thu 24 Sep 2026): lease_liabilities_total (every lease liability on
//     the balance sheet, current plus non-current), lease_liabilities_current and
//     lease_liabilities_non_current. The bare key lease_liabilities is retired: it held the
//     non-current line here and the total in the engine. Every former lease_liabilities figure
//     is now lease_liabilities_non_current with its value unchanged. That is a definition change
//     applied to every case at once, from the pages, not a value moved towards the engine.
//   - method "derived" marks a figure the filing does not print as a single figure, worked out
//     from printed ones named in derivedFrom (a total where only the split is printed). It is
//     never scored as a read.
//
// Scored by the UK eval gate, eval/gold/uk-run.ts, in npm run eval (WP-BE13).

export type UkFigureStatus = "candidate" | "tag-derived" | "tie-checked" | "claude-checked" | "cam-checked" | "cam-corrected";

// The statuses that mean a person opened the page. claude-checked is deliberately absent.
export const PERSON_CHECKED: readonly UkFigureStatus[] = ["cam-checked", "cam-corrected"];
export const isPersonChecked = (f: { status: UkFigureStatus }): boolean => PERSON_CHECKED.includes(f.status);

// Every label, in the order reports list them, with what it rests on.
export const STATUS_MEANING: Record<UkFigureStatus, string> = {
  "cam-checked": "Cam opened the page; figure, sign and scale right. A person's check.",
  "cam-corrected": "Cam opened the page and gave the right value. A person's check.",
  "claude-checked": "PROVISIONAL, not a person's check: Claude's visual read and a local OCR presence test agree.",
  "tie-checked": "Agent-read; a printed arithmetic identity on the page holds with it. Not checked by anyone.",
  "tag-derived": "From iXBRL or ESEF tags through the extractors. No model and no eye read it.",
  candidate: "Agent-read only. Not checked by anyone.",
};

export interface UkFigureCheck {
  by: "claude-visual" | "apple-vision-ocr" | "cam";
  date: string; // YYYY-MM-DD
  result: "right" | "wrong" | "corrected";
  person: boolean; // true only for Cam
  source: string; // the document holding the check, repo-relative
  note?: string;
}

const CLAUDE_VISUAL: UkFigureCheck = {
  by: "claude-visual",
  date: "2026-09-21",
  result: "right",
  person: false,
  source: "product/eval/gold/uk/spot-check-2026-09-16.md",
  note: "Claude (session 3de13e6d) read the rendered page image at Cam's request. Not Cam's check.",
};
const APPLE_OCR: UkFigureCheck = {
  by: "apple-vision-ocr",
  date: "2026-09-21",
  result: "right",
  person: false,
  source: "docs/deepdives/local-ocr-gold-2026-09-21.md",
  note: "Presence test only: the printed text is on that page. Not tied to its row or column.",
};
const PROVISIONAL: UkFigureCheck[] = [CLAUDE_VISUAL, APPLE_OCR];

export interface UkGoldFigure {
  metric: string; // WP-BE01 base line key where one exists
  period: string; // period end, YYYY-MM-DD
  value: number | "ABSTAIN"; // in pounds, sign applied
  document?: string; // file in the case folder when not filing.pdf (for example "parent.pdf")
  checks?: UkFigureCheck[]; // who looked at this figure after it was keyed
  printedText?: string; // exactly as printed, for example "(1,234)"
  scaleCaption?: string; // for example "£'000"
  pdfPage?: number; // 1-based PDF page index
  printedPage?: string;
  statement?: string; // for example "Balance sheet"
  printedLabel?: string; // the line label as printed
  noteRef?: string;
  method: "agent-read" | "ixbrl-tag" | "esef-tag" | "derived";
  derivedFrom?: string; // method "derived": the printed figures and the arithmetic
  status: UkFigureStatus;
  ties?: string[]; // arithmetic checks this figure took part in: a part-1 description, or a UK_TIES id
  concept?: string; // tag-derived: the tagged concept the extractor used
  spotCheck?: number; // row number on uk/spot-check-2026-09-16.md
}

export interface UkParentFiling {
  companyNumber: string;
  name: string;
  transactionId: string;
  filingType: string;
  pageCount: number;
  file: string;
  periodEnd: string;
}

export interface UkGoldCase {
  key: string;
  companyNumber: string;
  name: string;
  transactionId: string; // CH transaction id; for the ESEF case, the filings.xbrl.org fxo id
  madeUpDate: string;
  accountsType: string;
  pageCount: number; // 0 for the ESEF case, which has no pages
  kind: string; // scan-full | scan-group | large-group | subsidiary | ixbrl | esef
  folder: string; // under eval/gold/fixtures/uk/
  filingType: string; // AA | AAMD | ESEF
  scan: boolean; // image-only PDF (textLayerChars 2 in meta.json)
  parent?: UkParentFiling;
  figures: UkGoldFigure[];
  facilities?: UkGoldFacility[];
  notes: string;
}

// A facility as the debt note prints it. Amounts in pounds. Fields the note does not print are
// left out, never guessed. quote is verbatim from the page image.
export interface UkGoldFacility {
  type: string; // a WP-BE01 FACILITY_TYPES value (lib/vision/types.ts)
  nameAsPrinted: string;
  lender?: string;
  amount?: number; // committed size
  drawnAtPeriodEnd?: number;
  undrawnAtPeriodEnd?: number;
  accordion?: number;
  rate?: string;
  maturity?: string;
  security?: string;
  ranking?: string;
  covenants?: string;
  guarantee?: string;
  pdfPage: number;
  printedPage?: string;
  noteRef?: string;
  status: UkFigureStatus;
  quote: string;
}

// A printed arithmetic identity, as data, so test/ukGold.test.ts can recompute it. terms and
// total are in printed units with the printed sign (brackets negative). A tie that does not
// hold is recorded with holds: false and a reason: that is a finding, never a fix.
// unit is the last printed digit (0.1 for "12.5" under £m, 1 for "12,500" under £'000). An
// identity holds when |sum of terms - total| is at most half a unit per figure in it (rounding).
export interface UkTie {
  id: string;
  caseKey: string;
  kind: "balance-sheet" | "income-statement" | "borrowings" | "net-debt" | "leases" | "cash" | "facility" | "cross-source";
  pdfPages: number[];
  scaleCaption: string;
  unit: number;
  identities: { terms: [string, number][]; total: [string, number] }[];
  holds: boolean;
  note?: string;
}

// Tie descriptions, shared by the figures that took part in each.
const BW_SFP = "Bristol Water SFP 31 Mar 2026 (£m): current assets 11.4+0+0+1.7=13.1; total assets 26.6+13.1=39.7; non-current liabilities 1.6+12.5=14.1; total liabilities 14.1+0.5=14.6; net assets 39.7-14.6=25.1; equity 6.0+4.4+5.8+8.9=25.1. Holds.";
const BW_IS = "Bristol Water income statement FY to 31 Mar 2026 (£m): operating (0.7) + net interest 1.3 = PBT 0.6; interest (1.1)+2.4=1.3; PBT 0.6 + tax (0.5) = profit 0.1. Holds.";
const TL_BS = "Travelodge balance sheet 31 Dec 2024 (£m): non-current assets 2,457.9 + current assets 811.2 = 3,269.1; current liabilities 316.5 + non-current 2,580.5 = 2,897.0; net assets 3,269.1-2,897.0=372.1 = equity 300.0+20.6+51.5. Holds.";
const MT_SFP = "Matalan SFP 28 Feb 2026 (£'m): non-current 430.4 + current 313.5 = 743.9; current liabilities 546.6 + non-current 263.9 = 810.5; 743.9-810.5 = (66.6) = equity 0+(2.9)+(63.7). Holds.";
const PE_SFP = "PizzaExpress SFP 29 Dec 2024 (£000): fixed 1,990; current assets 1,409+1,123,072+17,375=1,141,856; net current (69,963); TALCL (67,973); non-current (6,447)+(110)=(6,557); net liabilities (74,530) = equity 7,179+61,869+(143,578). Holds.";
const SS_SFP = "Solid State consolidated SFP 31 Mar 2026 (£'000): non-current 47,595 + current 59,619 = 107,214; current liabilities 26,048 + non-current 17,852 = 43,900; net assets 63,314 = equity 2,854+28,300+(64)+(2,876)+35,600+(500). Holds.";
const SS_BORROW = "Solid State note 19 at 31 Mar 2026 (£'000): by type 17+0+10,142=10,159; by maturity 17+0+10,142=10,159; current (17) and non-current (10,142) equal the SFP lines on PDF page 93. Holds.";
const BH_BORROW ="Boparan note 21 Borrowings 26 Jul 2025 (£m): bond notes 390.0+7.5+(7.6)=389.9; 389.9+(0.8)+0.2=389.3; due within one year 7.7 + after 381.6 = 389.3; after-one-year 381.6 equals balance sheet creditors after more than one year (381.6). Holds.";
const BH_BS ="Boparan consolidated balance sheet 26 Jul 2025 (£m): current assets 60.8+125.6+90.8+105.4=382.6; net current 382.6-341.7=40.9; TALCL 220.5+40.9=261.4; 261.4-381.6-2.8=(123.0); -138.6 pension = (261.6) = 132.6+(394.2). Holds.";

export const UK_GOLD: UkGoldCase[] = [
  {
    key: "bristol-water-2026",
    companyNumber: "02662226",
    name: "BRISTOL WATER PLC",
    transactionId: "MzU0MjkxMjg1OGFkaXF6a2N4",
    madeUpDate: "2026-03-31",
    accountsType: "full",
    pageCount: 28,
    kind: "scan-full",
    folder: "02662226-2026-03-31",
    filingType: "AA",
    scan: true,
    figures: [
      {
        metric: "preference_shares", period: "2026-03-31", value: -12_500_000,
        printedText: "(12.5)", scaleCaption: "£m", pdfPage: 10, printedPage: "10",
        statement: "Statement of financial position", printedLabel: "8.75% irredeemable cumulative preference shares",
        noteRef: "13,15", method: "agent-read", status: "claude-checked", ties: [BW_SFP], checks: PROVISIONAL, spotCheck: 1,
      },
      {
        metric: "cash_at_bank", period: "2026-03-31", value: 1_700_000,
        printedText: "1.7", scaleCaption: "£m", pdfPage: 10, printedPage: "10",
        statement: "Statement of financial position", printedLabel: "Cash and cash equivalents",
        noteRef: "12", method: "agent-read", status: "claude-checked", ties: [BW_SFP], checks: PROVISIONAL, spotCheck: 2,
      },
      {
        metric: "operating_profit", period: "2026-03-31", value: -700_000,
        printedText: "(0.7)", scaleCaption: "£m", pdfPage: 9, printedPage: "9",
        statement: "Income statement", printedLabel: "Operating profit(loss)",
        method: "agent-read", status: "claude-checked", ties: [BW_IS], checks: PROVISIONAL, spotCheck: 3,
      },
      {
        metric: "borrowings_after_one_year", period: "2026-03-31", value: -1_600_000,
        printedText: "(1.6)", scaleCaption: "£m", pdfPage: 10, printedPage: "10",
        statement: "Statement of financial position", printedLabel: "Borrowings (non-current liabilities)",
        noteRef: "13", method: "agent-read", status: "tie-checked", ties: [BW_SFP],
      },
      {
        // WP-BE17 changed this from -1,100,000 to ABSTAIN. Note 6 (PDF page 15) shows the whole
        // (1.1) is "Dividends on 8.75% irredeemable cumulative preference shares", the only line
        // under "Less interest payable and similar charges". The reader's definition
        // (lib/vision/prompt.ts, interest_payable) says preference dividends are not interest and
        // to abstain when no figure without them is printed. None is. This agrees with what the
        // first reader already did (WP-BE05 disagreement 5); the reason is note 6, not the engine.
        metric: "interest_payable", period: "2026-03-31", value: "ABSTAIN",
        printedText: "(1.1)", scaleCaption: "£m", pdfPage: 9, printedPage: "9",
        statement: "Income statement", printedLabel: "Interest payable and similar charges",
        noteRef: "6", method: "agent-read", status: "tie-checked", ties: [BW_IS, "bw-note6-interest"],
      },
      {
        metric: "preference_dividends", period: "2026-03-31", value: -1_100_000,
        printedText: "(1.1)", scaleCaption: "£m", pdfPage: 15, printedPage: "15",
        statement: "Note 6 Net interest receivable and similar income", printedLabel: "Dividends on 8.75% irredeemable cumulative preference shares",
        noteRef: "6", method: "agent-read", status: "tie-checked", ties: ["bw-note6-interest"],
      },
      {
        metric: "debentures", period: "2026-03-31", value: 1_600_000,
        printedText: "1.6", scaleCaption: "£m", pdfPage: 20, printedPage: "20",
        statement: "Note 13 Borrowings", printedLabel: "Debentures (Irredeemable)",
        noteRef: "13", method: "agent-read", status: "tie-checked", ties: ["bw-note13-borrowings"],
      },
      {
        metric: "borrowings_note_total_incl_preference_shares", period: "2026-03-31", value: 14_100_000,
        printedText: "14.1", scaleCaption: "£m", pdfPage: 20, printedPage: "20",
        statement: "Note 13 Borrowings", printedLabel: "Total non- current loans and borrowings",
        noteRef: "13", method: "agent-read", status: "tie-checked", ties: ["bw-note13-borrowings"],
      },
      {
        metric: "net_assets", period: "2026-03-31", value: 25_100_000,
        printedText: "25.1", scaleCaption: "£m", pdfPage: 10, printedPage: "10",
        statement: "Statement of financial position", printedLabel: "Net assets",
        method: "agent-read", status: "tie-checked", ties: [BW_SFP],
      },
      {
        metric: "total_assets", period: "2026-03-31", value: 39_700_000,
        printedText: "39.7", scaleCaption: "£m", pdfPage: 10, printedPage: "10",
        statement: "Statement of financial position", printedLabel: "Total assets",
        method: "agent-read", status: "tie-checked", ties: [BW_SFP],
      },
    ],
    facilities: [
      {
        type: "notes_or_bonds", nameAsPrinted: "£1,405,218 Consolidated debentures", amount: 1_400_000,
        rate: "4.00%", maturity: "irredeemable", pdfPage: 20, printedPage: "20", noteRef: "13", status: "tie-checked",
        quote: "£1,405,218 Consolidated debentures 4.00% irredeemable 1.4 1.4",
      },
      {
        type: "notes_or_bonds", nameAsPrinted: "perpetual debentures (three issues)", amount: 200_000,
        rate: "4.25%, 4.00% and 3.50%", maturity: "irredeemable", pdfPage: 20, printedPage: "20", noteRef: "13", status: "tie-checked",
        quote: "£36,740 perpetual debentures 4.25% irredeemable - -; £54,875 perpetual debentures 4.00% irredeemable 0.1 0.1; £72,900 perpetual debentures 3.50% irredeemable 0.1 0.1",
      },
    ],
    notes: "The preference shares trap (audit finding 19). The 8.75% irredeemable cumulative preference shares are printed on their own line, separate from Borrowings (1.6), and must not be counted as borrowings. WP-BE17 read note 6 (PDF page 15) and note 13 (PDF page 20). Note 6: the whole of interest payable (1.1) is the preference dividend, \"classified as interest in accordance with IFRS 9\", so interest_payable is ABSTAIN. Note 13 is headed BORROWINGS and its total of 14.1 includes the preference shares (1.6 debentures + 12.5 preference shares): a reader that takes the note total as borrowings counts the preference shares as debt. The debentures are four irredeemable issues, no security printed. No bank facility is printed. The contents page (PDF page 2) numbers the statements two higher than the printed page footers; the footer matches the PDF page index.",
  },
  {
    key: "pret-a-manger-2026",
    companyNumber: "11391321",
    name: "PRET A MANGER LIMITED",
    transactionId: "MzUyNzQ5NTk5NmFkaXF6a2N4",
    madeUpDate: "2026-01-01",
    accountsType: "audit-exemption-subsiduary",
    pageCount: 27,
    kind: "subsidiary",
    folder: "11391321-2026-01-01",
    filingType: "AA",
    scan: true,
    parent: {
      companyNumber: "13383544",
      name: "Pret Parent Holding Limited",
      transactionId: "MzUyNzQ5NTk3MWFkaXF6a2N4",
      filingType: "PARENT_ACC",
      pageCount: 106,
      file: "parent.pdf",
      periodEnd: "2026-01-01",
    },
    figures: [
      {
        metric: "cash_at_bank", period: "2026-01-01", value: 139_000,
        printedText: "139", scaleCaption: "£'000", pdfPage: 9, printedPage: "8",
        statement: "Statement of financial position (Company)", printedLabel: "Cash and cash equivalents",
        method: "agent-read", status: "tie-checked", ties: ["pret-sub-sfp"],
      },
      {
        metric: "borrowings_within_one_year", period: "2026-01-01", value: -123_591_000,
        printedText: "(123,591)", scaleCaption: "£'000", pdfPage: 9, printedPage: "8",
        statement: "Statement of financial position (Company)", printedLabel: "Loans and borrowings (current)",
        noteRef: "13", method: "agent-read", status: "tie-checked", ties: ["pret-sub-sfp"],
      },
      {
        metric: "borrowings_after_one_year", period: "2026-01-01", value: -420_270_000,
        printedText: "(420,270)", scaleCaption: "£'000", pdfPage: 9, printedPage: "8",
        statement: "Statement of financial position (Company)", printedLabel: "Loans and borrowings (non-current)",
        noteRef: "13", method: "agent-read", status: "tie-checked", ties: ["pret-sub-sfp"],
      },
      {
        metric: "net_assets", period: "2026-01-01", value: 759_221_000,
        printedText: "759,221", scaleCaption: "£'000", pdfPage: 9, printedPage: "8",
        statement: "Statement of financial position (Company)", printedLabel: "Net assets",
        method: "agent-read", status: "tie-checked", ties: ["pret-sub-sfp"],
      },
      {
        metric: "cash_at_bank", period: "2026-01-01", value: 18_700_000, document: "parent.pdf",
        printedText: "18 7", scaleCaption: "£m", pdfPage: 42, printedPage: "41",
        statement: "Consolidated Statement of Financial Position (Pret Parent Holding Limited)", printedLabel: "Cash and cash equivalents",
        method: "agent-read", status: "tie-checked", ties: ["pret-parent-sfp"],
      },
      {
        metric: "borrowings_within_one_year", period: "2026-01-01", value: -133_100_000, document: "parent.pdf",
        printedText: "(133 1)", scaleCaption: "£m", pdfPage: 42, printedPage: "41",
        statement: "Consolidated Statement of Financial Position (Pret Parent Holding Limited)", printedLabel: "Loans and borrowings (current)",
        noteRef: "22", method: "agent-read", status: "tie-checked", ties: ["pret-parent-sfp"],
      },
      {
        metric: "borrowings_after_one_year", period: "2026-01-01", value: -420_300_000, document: "parent.pdf",
        printedText: "(420 3)", scaleCaption: "£m", pdfPage: 42, printedPage: "41",
        statement: "Consolidated Statement of Financial Position (Pret Parent Holding Limited)", printedLabel: "Loans and borrowings (non-current)",
        noteRef: "22", method: "agent-read", status: "tie-checked", ties: ["pret-parent-sfp"],
      },
      {
        metric: "lease_liabilities_non_current", period: "2026-01-01", value: -322_600_000, document: "parent.pdf",
        printedText: "(322 6)", scaleCaption: "£m", pdfPage: 42, printedPage: "41",
        statement: "Consolidated Statement of Financial Position (Pret Parent Holding Limited)", printedLabel: "Lease liabilities (non-current)",
        noteRef: "13", method: "agent-read", status: "tie-checked", ties: ["pret-parent-sfp"],
      },
      {
        metric: "lease_liabilities_current", period: "2026-01-01", value: -103_400_000, document: "parent.pdf",
        printedText: "(103 4)", scaleCaption: "£m", pdfPage: 42, printedPage: "41",
        statement: "Consolidated Statement of Financial Position (Pret Parent Holding Limited)", printedLabel: "Lease liabilities (current)",
        noteRef: "13", method: "agent-read", status: "tie-checked", ties: ["pret-parent-sfp"],
      },
      {
        // WP-BE23: no total is printed on the pages read, so the total is the sum of the two
        // printed lines, derived, not printed. RS-01: "with the total derived as 426.0 unless a
        // note prints it". Pret's lease note has not been read.
        metric: "lease_liabilities_total", period: "2026-01-01", value: -426_000_000, document: "parent.pdf",
        statement: "Consolidated Statement of Financial Position (Pret Parent Holding Limited)",
        derivedFrom: "current (103.4) + non-current (322.6), both printed on PDF page 42",
        noteRef: "13", method: "derived", status: "tie-checked", ties: ["pret-parent-sfp"],
      },
      {
        metric: "net_assets", period: "2026-01-01", value: 288_000_000, document: "parent.pdf",
        printedText: "288.0", scaleCaption: "£m", pdfPage: 42, printedPage: "41",
        statement: "Consolidated Statement of Financial Position (Pret Parent Holding Limited)", printedLabel: "Net assets",
        method: "agent-read", status: "tie-checked", ties: ["pret-parent-sfp"],
      },
    ],
    notes: "WP-BE17 keyed the subsidiary's own statement of financial position (filing.pdf PDF page 9, printed 8, £'000, headed \"Company\") and the parent's consolidated one (parent.pdf PDF page 42, printed 41, £m, headed \"Group\"; contents on PDF page 2 printed 1, so PDF = printed + 1). Trap for the reader: in the parent scan most decimal points do not render, so \"(133 1)\" is 133.1 and \"1,023 5\" is 1,023.5; printedText records what the image shows. Only \"(441.4)\", \"288.0\" and \"1,021.1\" show a point. Every value was confirmed by the ties. The subsidiary is the group's borrower: its loans (123,591 and 420,270 £'000) are close to the group's (133.1 and 420.3 £m). Neither debt note was read. Audit-exempt subsidiary (s479A). Its parent's consolidated accounts were filed with it on 21 Jun 2026 as PARENT_ACC and are frozen as parent.pdf. The parent is named on parent.pdf page 1: \"Pret Parent Holding Limited, Annual Report and Consolidated Financial Statements, 52 week Period ended 1 January 2026, Company number 13383544\". The credit story sits at the parent (audit finding 22). No figures keyed in part 1.",
  },
  {
    key: "boparan-holdings-2025",
    companyNumber: "03558065",
    name: "BOPARAN HOLDINGS LIMITED",
    transactionId: "MzUxODk5OTExM2FkaXF6a2N4",
    madeUpDate: "2025-07-26",
    accountsType: "group",
    pageCount: 113,
    kind: "scan-group",
    folder: "03558065-2025-07-26",
    filingType: "AA",
    scan: true,
    figures: [
      {
        metric: "cash_at_bank", period: "2025-07-26", value: 105_400_000,
        printedText: "105.4", scaleCaption: "£m", pdfPage: 59, printedPage: "59",
        statement: "Consolidated balance sheet", printedLabel: "Cash at bank and in hand",
        method: "agent-read", status: "claude-checked", ties: [BH_BS], checks: PROVISIONAL, spotCheck: 8,
      },
      {
        metric: "net_assets", period: "2025-07-26", value: -261_600_000,
        printedText: "(261.6)", scaleCaption: "£m", pdfPage: 59, printedPage: "59",
        statement: "Consolidated balance sheet", printedLabel: "Net liabilities",
        method: "agent-read", status: "tie-checked", ties: [BH_BS],
      },
      {
        metric: "facility_rcf_commitment", period: "2025-07-26", value: 80_000_000,
        printedText: "£80.0m", scaleCaption: "£m (in the sentence)", pdfPage: 91, printedPage: "91",
        statement: "Note 21 Borrowings (narrative)", printedLabel: "super senior secured RCF",
        noteRef: "21", method: "agent-read", status: "claude-checked", checks: PROVISIONAL, spotCheck: 9,
      },
      {
        // WP-BE17 changed this from 7,700,000 to 7,500,000. Note 21's "Due within one year 7.7"
        // includes obligations under finance leases of 0.2; the same page prints "Bond notes and
        // other borrowings: Within one year or less or on demand 7.5" with the leases on their own
        // line, and note 28 (PDF page 97) prints "Debt due within one year (7.5)" beside "Finance
        // leases (0.2)". The reader's definition (lib/vision/prompt.ts) says leases never go in
        // the borrowings lines. So the key is 7.5. This AGREES with what both model reads said
        // (WP-BE05 disagreement 2), which WP-BE05 called a misread; the reason for the change is
        // the printed lease split, and the 7.7 line is kept below under its own name.
        metric: "borrowings_within_one_year", period: "2025-07-26", value: 7_500_000,
        printedText: "7.5", scaleCaption: "£m", pdfPage: 91, printedPage: "91",
        statement: "Note 21 Borrowings", printedLabel: "Bond notes and other borrowings: Within one year or less or on demand (note 19)",
        noteRef: "21", method: "agent-read", status: "tie-checked", ties: ["bh-note21-bonds-split", "bh-note28-net-debt"],
      },
      {
        metric: "borrowings_within_one_year_incl_finance_leases", period: "2025-07-26", value: 7_700_000,
        printedText: "7.7", scaleCaption: "£m", pdfPage: 91, printedPage: "91",
        statement: "Note 21 Borrowings", printedLabel: "Due within one year",
        noteRef: "21", method: "agent-read", status: "tie-checked", ties: [BH_BORROW],
      },
      {
        metric: "lease_liabilities_total", period: "2025-07-26", value: 200_000,
        printedText: "0.2", scaleCaption: "£m", pdfPage: 91, printedPage: "91",
        statement: "Note 21 Borrowings", printedLabel: "Obligations under finance leases (note 23)",
        noteRef: "21", method: "agent-read", status: "tie-checked", ties: [BH_BORROW, "bh-note28-net-debt"],
      },
      {
        metric: "net_debt", period: "2025-07-26", value: -276_400_000,
        printedText: "(276.4)", scaleCaption: "£m", pdfPage: 97, printedPage: "97",
        statement: "Note 28 Analysis of net debt", printedLabel: "Net debt (26 July 2025)",
        noteRef: "28", method: "agent-read", status: "tie-checked", ties: ["bh-note28-net-debt"],
      },
      {
        metric: "borrowings_after_one_year", period: "2025-07-26", value: 381_600_000,
        printedText: "381.6", scaleCaption: "£m", pdfPage: 91, printedPage: "91",
        statement: "Note 21 Borrowings", printedLabel: "Due after more than one year",
        noteRef: "21", method: "agent-read", status: "tie-checked", ties: [BH_BORROW],
      },
    ],
    facilities: [
      {
        type: "notes_or_bonds", nameAsPrinted: "£390.0m Senior Loan Notes due November 2029", amount: 390_000_000,
        drawnAtPeriodEnd: 390_000_000, rate: "9.375% per annum", maturity: "November 2029", security: "senior secured",
        pdfPage: 91, noteRef: "21", status: "candidate",
        quote: "The bonds comprise of £390.0m Senior Loan Notes due November 2029 at an interest rate of 9.375% per annum.",
      },
      {
        type: "revolving_credit_facility", nameAsPrinted: "super senior secured RCF", amount: 80_000_000,
        drawnAtPeriodEnd: 0, maturity: "November 2029", security: "super senior secured", ranking: "super senior",
        pdfPage: 91, noteRef: "21", status: "candidate",
        quote: "The Group has an £80.0m super senior secured RCF which may be increased on an uncommitted basis to £90.0m at the option of the Group, maturing in November 2029. Other borrowings include amounts drawn on the Group's RCF facility and was undrawn at the year end (2024: £nil).",
      },
    ],
    notes: "FRS 102 group accounts, £m. PDF page index equals the printed page number. Note 21 Borrowings (PDF page 91, found by local OCR page-finding) shows due after more than one year 381.6, which equals all of creditors falling due after more than one year on the balance sheet. Refinanced on 7 Nov 2024: \"the issuance of a new £390.0m senior secured bond and a new £80.0m secured Revolving Credit Facility (RCF)\". Note 21 calls the RCF \"secured\" in one sentence and \"super senior secured\" in the next; the facilities entry uses the second. The pension deficit (138.6) is shown below net liabilities excluding pension. Borrowings are 389.3 net of unamortised fees (7.6) and (0.8). WP-BE17: note 21 splits \"Bond notes and other borrowings\" (7.5 within one year, 381.6 after, 389.1) from \"Obligations under finance leases\" (0.2, all within one year), so borrowings_within_one_year is 7.5 and the 7.7 line includes the leases. Note 28 Analysis of net debt (PDF page 97) ties: total borrowings (389.3) plus the bond interest accrual 7.5 added back plus cash 105.4 is net debt (276.4). The note says net debt \"comprises bonds, other borrowings and finance leases net of cash\" and that the interest accrual and prepaid fees are treated as management sees them. The WP-BE05 net debt tie (389.3 less 105.4 = 283.9, out by 7.5) failed because it did not know the accrual add-back; the add-back is printed. The balance sheet shows no lease line; finance leases sit inside borrowings, so no lease_liabilities_non_current is keyed and lease_liabilities_total (0.2) is.",
  },
  {
    key: "topps-tiles-2025",
    companyNumber: "03213782",
    name: "TOPPS TILES PLC",
    transactionId: "MzUwNzM2NzQwNGFkaXF6a2N4",
    madeUpDate: "2025-09-27",
    accountsType: "group",
    pageCount: 226,
    kind: "large-group",
    folder: "03213782-2025-09-27",
    filingType: "AA",
    scan: true,
    figures: [
      {
        metric: "turnover", period: "2025-09-27", value: 295_754_000,
        printedText: "295,754", scaleCaption: "£'000", pdfPage: 150, printedPage: "148",
        statement: "Consolidated Statement of Profit or Loss", printedLabel: "Group revenue",
        noteRef: "3", method: "agent-read", status: "tie-checked", ties: ["topps-pl"],
      },
      {
        metric: "operating_profit", period: "2025-09-27", value: 15_299_000,
        printedText: "15,299", scaleCaption: "£'000", pdfPage: 150, printedPage: "148",
        statement: "Consolidated Statement of Profit or Loss", printedLabel: "Group operating profit/(loss)",
        method: "agent-read", status: "tie-checked", ties: ["topps-pl"],
      },
      {
        metric: "interest_payable", period: "2025-09-27", value: -7_295_000,
        printedText: "(7,295)", scaleCaption: "£'000", pdfPage: 150, printedPage: "148",
        statement: "Consolidated Statement of Profit or Loss", printedLabel: "Finance costs",
        noteRef: "6", method: "agent-read", status: "tie-checked", ties: ["topps-pl"],
      },
      {
        metric: "cash_at_bank", period: "2025-09-27", value: 18_434_000,
        printedText: "18,434", scaleCaption: "£'000", pdfPage: 151, printedPage: "149",
        statement: "Consolidated Statement of Financial Position", printedLabel: "Cash and cash equivalents",
        noteRef: "18", method: "agent-read", status: "tie-checked", ties: ["topps-sfp", "topps-note18-cash", "topps-net-cash"],
      },
      {
        metric: "lease_liabilities_non_current", period: "2025-09-27", value: -83_010_000,
        printedText: "(83,010)", scaleCaption: "£'000", pdfPage: 151, printedPage: "149",
        statement: "Consolidated Statement of Financial Position", printedLabel: "Lease liabilities (non-current liabilities)",
        noteRef: "14", method: "agent-read", status: "tie-checked", ties: ["topps-sfp", "topps-leases"],
      },
      {
        metric: "lease_liabilities_current", period: "2025-09-27", value: -16_782_000,
        printedText: "(16,782)", scaleCaption: "£'000", pdfPage: 151, printedPage: "149",
        statement: "Consolidated Statement of Financial Position", printedLabel: "Lease liabilities (current liabilities)",
        noteRef: "14", method: "agent-read", status: "tie-checked", ties: ["topps-sfp", "topps-leases"],
      },
      {
        metric: "lease_liabilities_total", period: "2025-09-27", value: 99_792_000,
        printedText: "99,792", scaleCaption: "£'000", pdfPage: 183, printedPage: "181",
        statement: "Note 19 Bank Loans, reconciliation of financial liabilities", printedLabel: "Lease liabilities, As at 27 September 2025",
        noteRef: "19", method: "agent-read", status: "tie-checked", ties: ["topps-leases", "topps-lease-roll"],
      },
      {
        metric: "borrowings_after_one_year", period: "2025-09-27", value: -11_000_000,
        printedText: "(11,000)", scaleCaption: "£'000", pdfPage: 151, printedPage: "149",
        statement: "Consolidated Statement of Financial Position", printedLabel: "Bank loans (non-current liabilities)",
        noteRef: "19", method: "agent-read", status: "tie-checked", ties: ["topps-sfp", "topps-net-cash"],
      },
      {
        metric: "net_current_liabilities", period: "2025-09-27", value: -2_091_000,
        printedText: "(2,091)", scaleCaption: "£'000", pdfPage: 151, printedPage: "149",
        statement: "Consolidated Statement of Financial Position", printedLabel: "Net current (liabilities)/assets",
        method: "agent-read", status: "tie-checked", ties: ["topps-sfp"],
      },
      {
        metric: "net_assets", period: "2025-09-27", value: 7_727_000,
        printedText: "7,727", scaleCaption: "£'000", pdfPage: 151, printedPage: "149",
        statement: "Consolidated Statement of Financial Position", printedLabel: "Net assets",
        method: "agent-read", status: "tie-checked", ties: ["topps-sfp"],
      },
      {
        metric: "total_assets", period: "2025-09-27", value: 187_893_000,
        printedText: "187,893", scaleCaption: "£'000", pdfPage: 151, printedPage: "149",
        statement: "Consolidated Statement of Financial Position", printedLabel: "Total assets",
        method: "agent-read", status: "tie-checked", ties: ["topps-sfp"],
      },
    ],
    facilities: [
      {
        type: "revolving_credit_facility", nameAsPrinted: "revolving credit facility", amount: 30_000_000,
        drawnAtPeriodEnd: 11_000_000, undrawnAtPeriodEnd: 19_000_000, maturity: "October 2027",
        covenants: "financial covenants tested on a bi-annual basis; no breach in the period",
        pdfPage: 183, printedPage: "181", noteRef: "19", status: "tie-checked",
        quote: "At 27 September 2025, the Group had a revolving credit facility of £30.0 million, expiring in October 2027. As at the financial period end, £11.0 million of this was drawn (2024: £15.0 million), leaving £19.0 million of undrawn committed banking facilities. The loan facility contains financial covenants which are tested on a bi-annual basis. The Group did not breach any covenants in the period.",
      },
    ],
    notes: "The IFRS 16 lease case. Group accounts scan over 200 pages (13.8 MB), £'000, PDF page = printed page + 2. Lease liabilities (99,792 in total: 16,782 current and 83,010 non-current) are nine times the only bank debt, the RCF drawn at 11,000. The reconciliation in note 19 (PDF 182 to 183) rolls both forward. A leverage figure with leases and one without differ by an order of magnitude; the gold keys both lines so either definition can be scored. The rate or margin, the security and the lenders are not printed on the pages read. The company's own \"adjusted net cash of £7.4 million\" (\"comprising cash and cash equivalents of £18.4 million less revolving credit facility draw down of £11.0 million\", going concern policy, PDF page 154, found by local OCR and then read by eye) excludes leases. Pages read by eye: 150, 151, 154, 182, 183. The lease note itself (14, PDF 176 to 179) was not read.",
  },
  {
    key: "james-fisher-2025",
    companyNumber: "00211475",
    name: "JAMES FISHER AND SONS PUBLIC LIMITED COMPANY",
    transactionId: "MzUyMzIyMjQwNmFkaXF6a2N4",
    madeUpDate: "2025-12-31",
    accountsType: "group",
    pageCount: 210,
    kind: "large-group",
    folder: "00211475-2025-12-31",
    filingType: "AA",
    scan: true,
    figures: [
      {
        metric: "turnover", period: "2025-12-31", value: 394_400_000,
        printedText: "394.4", scaleCaption: "£m", pdfPage: 124, printedPage: "122",
        statement: "Consolidated income statement", printedLabel: "Revenue",
        noteRef: "7", method: "agent-read", status: "tie-checked", ties: ["jf-is"],
      },
      {
        metric: "operating_profit", period: "2025-12-31", value: 16_100_000,
        printedText: "16.1", scaleCaption: "£m", pdfPage: 124, printedPage: "122",
        statement: "Consolidated income statement", printedLabel: "Operating profit",
        noteRef: "8", method: "agent-read", status: "tie-checked", ties: ["jf-is"],
      },
      {
        metric: "interest_payable", period: "2025-12-31", value: -16_500_000,
        printedText: "(16.5)", scaleCaption: "£m", pdfPage: 124, printedPage: "122",
        statement: "Consolidated income statement", printedLabel: "Finance expense",
        noteRef: "10", method: "agent-read", status: "tie-checked", ties: ["jf-is"],
      },
      {
        metric: "profit_before_tax", period: "2025-12-31", value: 4_300_000,
        printedText: "4.3", scaleCaption: "£m", pdfPage: 124, printedPage: "122",
        statement: "Consolidated income statement", printedLabel: "Profit before taxation",
        method: "agent-read", status: "tie-checked", ties: ["jf-is"],
      },
      {
        metric: "cash_at_bank", period: "2025-12-31", value: 58_800_000,
        printedText: "58.8", scaleCaption: "£m", pdfPage: 126, printedPage: "124",
        statement: "Consolidated statement of financial position", printedLabel: "Cash and cash equivalents",
        noteRef: "22", method: "agent-read", status: "tie-checked", ties: ["jf-sfp"],
      },
      {
        // The balance sheet line "Borrowings (141.3)" includes lease liabilities 70.4 and
        // cumulative preference shares 0.1 (note 25). The bank figure is printed in the note.
        metric: "borrowings_after_one_year", period: "2025-12-31", value: 70_800_000,
        printedText: "70.8", scaleCaption: "£m", pdfPage: 170, printedPage: "168",
        statement: "Note 25 Borrowings", printedLabel: "Non-current liabilities: Bank borrowings",
        noteRef: "25", method: "agent-read", status: "tie-checked", ties: ["jf-note25-noncurrent", "jf-bank-total"],
      },
      {
        // Current borrowings are printed as overdrafts 34.4 and bank borrowings 7.0, with no
        // line that adds the two and leaves out the leases. The reader must not add them.
        metric: "borrowings_within_one_year", period: "2025-12-31", value: "ABSTAIN",
        printedText: "61.6", scaleCaption: "£m", pdfPage: 170, printedPage: "168",
        statement: "Note 25 Borrowings", printedLabel: "Current liabilities: Borrowings (includes lease liabilities 20.2)",
        noteRef: "25", method: "agent-read", status: "tie-checked", ties: ["jf-note25-current"],
      },
      {
        metric: "borrowings_sfp_non_current_incl_leases_and_preference", period: "2025-12-31", value: -141_300_000,
        printedText: "(141.3)", scaleCaption: "£m", pdfPage: 126, printedPage: "124",
        statement: "Consolidated statement of financial position", printedLabel: "Borrowings (non-current liabilities)",
        noteRef: "25", method: "agent-read", status: "tie-checked", ties: ["jf-sfp", "jf-note25-noncurrent"],
      },
      {
        metric: "lease_liabilities_non_current", period: "2025-12-31", value: 70_400_000,
        printedText: "70.4", scaleCaption: "£m", pdfPage: 170, printedPage: "168",
        statement: "Note 25 Borrowings", printedLabel: "Non-current liabilities: Lease liabilities",
        noteRef: "25", method: "agent-read", status: "tie-checked", ties: ["jf-note25-noncurrent"],
      },
      {
        metric: "lease_liabilities_current", period: "2025-12-31", value: 20_200_000,
        printedText: "20.2", scaleCaption: "£m", pdfPage: 170, printedPage: "168",
        statement: "Note 25 Borrowings", printedLabel: "Current liabilities: Lease liabilities",
        noteRef: "25", method: "agent-read", status: "tie-checked", ties: ["jf-note25-current"],
      },
      {
        metric: "preference_shares", period: "2025-12-31", value: 100_000,
        printedText: "0.1", scaleCaption: "£m", pdfPage: 170, printedPage: "168",
        statement: "Note 25 Borrowings", printedLabel: "Non-current liabilities: Cumulative preference shares",
        noteRef: "25", method: "agent-read", status: "tie-checked", ties: ["jf-note25-noncurrent"],
      },
      {
        metric: "net_borrowings", period: "2025-12-31", value: 144_100_000,
        printedText: "144.1", scaleCaption: "£m", pdfPage: 147, printedPage: "145",
        statement: "Note 5.3 Leverage (Net debt - covenant basis : EBITDA)", printedLabel: "Net borrowings (Note 25)",
        noteRef: "5.3", method: "agent-read", status: "tie-checked", ties: ["jf-net-debt"],
      },
      {
        metric: "lease_liabilities_total", period: "2025-12-31", value: -90_600_000,
        printedText: "(90.6)", scaleCaption: "£m", pdfPage: 147, printedPage: "145",
        statement: "Note 5.3 Leverage (Net debt - covenant basis : EBITDA)", printedLabel: "Lease liabilities under IFRS 16 (Note 16)",
        noteRef: "5.3", method: "agent-read", status: "tie-checked", ties: ["jf-net-debt", "jf-leases"],
      },
      {
        metric: "net_debt_covenant_basis", period: "2025-12-31", value: 61_000_000,
        printedText: "61.0", scaleCaption: "£m", pdfPage: 147, printedPage: "145",
        statement: "Note 5.3 Leverage (Net debt - covenant basis : EBITDA)", printedLabel: "Net debt - covenant basis",
        noteRef: "5.3", method: "agent-read", status: "tie-checked", ties: ["jf-net-debt"],
      },
      {
        metric: "net_assets", period: "2025-12-31", value: 187_300_000,
        printedText: "187.3", scaleCaption: "£m", pdfPage: 126, printedPage: "124",
        statement: "Consolidated statement of financial position", printedLabel: "Net assets",
        method: "agent-read", status: "tie-checked", ties: ["jf-sfp"],
      },
    ],
    facilities: [
      {
        type: "revolving_credit_facility", nameAsPrinted: "committed revolving credit facility (RCF)", amount: 72_500_000,
        drawnAtPeriodEnd: 51_000_000, undrawnAtPeriodEnd: 21_500_000,
        rate: "between 3.0% and 3.5% above compounded SONIA, dependent on the leverage covenant",
        maturity: "September 2028 (first 1-year extension option exercised; originally September 2027)",
        covenants: "Net debt: EBITDA not to exceed 2.5x and interest cover greater than 4.5x, tested quarterly",
        pdfPage: 170, printedPage: "168", noteRef: "25", status: "tie-checked",
        quote: "In 2024, the Group agreed a single three-year (including two, plus 1-year extension options) committed £75.0m revolving credit facility (RCF) maturing in September 2027, alongside a five-year £20.0m term loan facility maturing in September 2029 made up of two £10.0m loans with amortisation commencing in 2027 (the Group's funding arrangements). The RCF included a £2.5m step-down in commitment during 2025 resulting in the total RCF reducing to £72.5m from £75.0m. During 2025 the Group exercised the first plus 1-year option on the RCF, extending the maturity date from September 2027 to September 2028. ... At 31 December 2025, the Group had drawn down £51.0m under the RCF (2024: £58.0m), leaving £21.5m (2024: £17.0m) undrawn and available.",
      },
      {
        type: "term_loan", nameAsPrinted: "five-year £20.0m term loan facility (two £10.0m loans)", amount: 20_000_000,
        rate: "5.0% above compounded SONIA", maturity: "September 2029, amortisation commencing in 2027",
        pdfPage: 170, printedPage: "168", noteRef: "25", status: "candidate",
        quote: "alongside a five-year £20.0m term loan facility maturing in September 2029 made up of two £10.0m loans with amortisation commencing in 2027 ... The term loans and the TCL bear interest at a rate of 5.0% and 5.5% respectively above compounded SONIA.",
      },
      {
        type: "other", nameAsPrinted: "Trade Cycle Loan Facility (TCL)", amount: 7_000_000,
        drawnAtPeriodEnd: 7_000_000, undrawnAtPeriodEnd: 0, rate: "5.5% above compounded SONIA",
        maturity: "repayable on demand, rolling basis, no fixed maturity date",
        guarantee: "80.0% guarantee from UK Export Finance (UKEF)",
        pdfPage: 170, printedPage: "168", noteRef: "25", status: "tie-checked",
        quote: "During the year, the Group agreed a Trade Cycle Loan Facility (TCL) of £7.0m, which is supported by an 80.0% guarantee from UK Export Finance (UKEF), the UK government's export credit agency. The TCL is repayable on demand and operates on a rolling basis with no fixed maturity date, provided that certain UKEF eligibility criteria regarding export activity and fossil fuel thresholds are met. ... At 31 December 2025, the Group had drawn down £7.0m under the TCL, leaving no amount undrawn and available.",
      },
    ],
    notes: "Group accounts scan over 200 pages (13.5 MB), £m, PDF page = printed page + 2. The trap: the balance sheet's \"Borrowings\" lines (61.6 current, 141.3 non-current) include lease liabilities (20.2 and 70.4) and cumulative preference shares (0.1); note 25 (PDF page 170) splits them. The note prints \"The closing balance of the Group's bank borrowings at 31 December 2025 was £77.8m\" = 70.8 + 7.0, and current overdrafts of 34.4 on their own line. Note 25 values are printed without brackets, so their gold values are positive, as on Boparan note 21. Facility check: RCF 51.0 + term loans 20.0 + TCL 7.0 = 78.0 against bank borrowings 77.8; the 0.2 gap is not explained on the page (probably fees). Security and lenders are not printed on this page. Note 5.3 (PDF page 147, printed 145, found by local OCR and read by eye) reconciles net borrowings 144.1 to \"Net debt - covenant basis\" 61.0; see the jf-net-debt tie. Page 171 (the rest of note 25) was not read. The 3.5% cumulative preference shares are redeemable and carry votes (note 25.2).",
  },
  {
    key: "tesco-esef-2026",
    companyNumber: "00445790",
    name: "TESCO PLC",
    transactionId: "2138002P5RNKC5W2JZ46-2026-02-28-ESEF-GB-0",
    madeUpDate: "2026-02-28",
    accountsType: "group (IFRS consolidated, ESEF)",
    pageCount: 0,
    kind: "esef",
    folder: "00445790-2026-02-28-esef",
    filingType: "ESEF",
    scan: false,
    figures: [
      { metric: "turnover", period: "2026-02-28", value: 73_712_000_000, scaleCaption: "GBP (tag)", method: "esef-tag", status: "tag-derived", concept: "ifrs-full:Revenue" },
      { metric: "operating_profit", period: "2026-02-28", value: 2_985_000_000, scaleCaption: "GBP (tag)", method: "esef-tag", status: "tag-derived", concept: "ifrs-full:ProfitLossFromOperatingActivities" },
      { metric: "cash_at_bank", period: "2026-02-28", value: 2_515_000_000, scaleCaption: "GBP (tag)", method: "esef-tag", status: "tag-derived", concept: "ifrs-full:CashAndCashEquivalents" },
      { metric: "interest_payable", period: "2026-02-28", value: 814_000_000, scaleCaption: "GBP (tag)", method: "esef-tag", status: "tag-derived", concept: "ifrs-full:FinanceCosts" },
      { metric: "borrowings_total", period: "2026-02-28", value: 7_196_000_000, scaleCaption: "GBP (tag)", method: "esef-tag", status: "tag-derived", concept: "ifrs-full:LongtermBorrowings + ifrs-full:ShorttermBorrowings" },
    ],
    notes: "UKSEF filing from filings.xbrl.org, LEI 2138002P5RNKC5W2JZ46, frozen as filing.json (5.9 MB). Figures from extractEsefFinancials on that file (uk/tags.ts); they match test/fixtures/tesco_esef.json. The extractor reports periodEnd 2026-03-01 because the xBRL instant is the start of the day after the year end; the period here is the 28 Feb 2026 year end. interest_payable is the FinanceCosts tag, which the ESEF path maps to netInterest; it is finance costs, not a net figure. borrowings_total has no WP-BE01 key: the extractor sums LongtermBorrowings and ShorttermBorrowings.",
  },
  {
    key: "tesco-scan-2026",
    companyNumber: "00445790",
    name: "TESCO PLC",
    transactionId: "MzUzNDMwNDQ5M2FkaXF6a2N4",
    madeUpDate: "2026-02-28",
    accountsType: "group",
    pageCount: 236,
    kind: "large-group",
    folder: "00445790-2026-02-28",
    filingType: "AA",
    scan: true,
    figures: [
      {
        metric: "cash_at_bank", period: "2026-02-28", value: 2_515_000_000,
        printedText: "2,515", scaleCaption: "£m", pdfPage: 125, printedPage: "123",
        statement: "Group balance sheet", printedLabel: "Cash and cash equivalents",
        noteRef: "19", method: "agent-read", status: "tie-checked", ties: ["tesco-bs", "tesco-esef-cash"],
      },
      {
        metric: "borrowings_within_one_year", period: "2026-02-28", value: -1_824_000_000,
        printedText: "(1,824)", scaleCaption: "£m", pdfPage: 125, printedPage: "123",
        statement: "Group balance sheet", printedLabel: "Borrowings (current liabilities)",
        noteRef: "22", method: "agent-read", status: "tie-checked", ties: ["tesco-bs", "tesco-esef-borrowings"],
      },
      {
        metric: "borrowings_after_one_year", period: "2026-02-28", value: -5_372_000_000,
        printedText: "(5,372)", scaleCaption: "£m", pdfPage: 125, printedPage: "123",
        statement: "Group balance sheet", printedLabel: "Borrowings (non-current liabilities)",
        noteRef: "22", method: "agent-read", status: "tie-checked", ties: ["tesco-bs", "tesco-esef-borrowings"],
      },
      {
        metric: "lease_liabilities_non_current", period: "2026-02-28", value: -7_225_000_000,
        printedText: "(7,225)", scaleCaption: "£m", pdfPage: 125, printedPage: "123",
        statement: "Group balance sheet", printedLabel: "Lease liabilities (non-current liabilities)",
        noteRef: "13", method: "agent-read", status: "tie-checked", ties: ["tesco-bs"],
      },
      {
        metric: "lease_liabilities_current", period: "2026-02-28", value: -659_000_000,
        printedText: "(659)", scaleCaption: "£m", pdfPage: 125, printedPage: "123",
        statement: "Group balance sheet", printedLabel: "Lease liabilities (current liabilities)",
        noteRef: "13", method: "agent-read", status: "tie-checked", ties: ["tesco-bs"],
      },
      {
        // WP-BE23. Read by eye at 300 dpi by RS-01 on Wed 23 Sep 2026 (docs/decisions/2026-09-23-
        // lease-liabilities-definition.md, branch rs/01): "Current 659 (2025: 618) / Non-current
        // 7,225 (2025: 7,098) / Total lease liabilities 7,884 (2025: 7,716)". Printed without
        // brackets in the note. 659 + 7,225 = 7,884 holds on the page.
        metric: "lease_liabilities_total", period: "2026-02-28", value: 7_884_000_000,
        printedText: "7,884", scaleCaption: "£m", pdfPage: 147, printedPage: "145",
        statement: "Note 13 Leases", printedLabel: "Total lease liabilities",
        noteRef: "13", method: "agent-read", status: "tie-checked", ties: ["note 13: current 659 + non-current 7,225 = total 7,884"],
      },
      {
        metric: "net_current_liabilities", period: "2026-02-28", value: -5_846_000_000,
        printedText: "(5,846)", scaleCaption: "£m", pdfPage: 125, printedPage: "123",
        statement: "Group balance sheet", printedLabel: "Net current liabilities",
        method: "agent-read", status: "tie-checked", ties: ["tesco-bs"],
      },
      {
        metric: "net_assets", period: "2026-02-28", value: 11_457_000_000,
        printedText: "11,457", scaleCaption: "£m", pdfPage: 125, printedPage: "123",
        statement: "Group balance sheet", printedLabel: "Net assets",
        method: "agent-read", status: "tie-checked", ties: ["tesco-bs"],
      },
    ],
    notes: "WP-BE17 keyed the group balance sheet (PDF page 125, printed 123, £m) by eye. Two cross-source checks hold: cash 2,515 equals the ESEF CashAndCashEquivalents tag, and borrowings 1,824 + 5,372 = 7,196 equals the ESEF borrowings_total (Long-term plus Short-term Borrowings). Leases (659 current, 7,225 non-current) exceed borrowings. The balance sheet total of assets is not printed as one line (the page prints non-current 30,991 and current 8,483 subtotals). Note 22 Borrowings (PDF 158) was not read, so no facilities are keyed for Tesco. 236-page group accounts scan (14.3 MB), under the 15 MB rule so committed. For page-finding on Thu (WP-BE15). No figures in part 1, by design. The ESEF case above is the same year and gives the answers to check page-finding against.",
  },
  {
    key: "busy-bees-nurseries-2025",
    companyNumber: "03454787",
    name: "BUSY BEES NURSERIES LIMITED",
    transactionId: "MzU0MjUzMDgyM2FkaXF6a2N4",
    madeUpDate: "2025-12-31",
    accountsType: "full",
    pageCount: 60,
    kind: "ixbrl",
    folder: "03454787-2025-12-31",
    filingType: "AA",
    scan: false,
    figures: [
      { metric: "turnover", period: "2025-12-31", value: 378_465_000, printedText: "378,465", method: "ixbrl-tag", status: "tag-derived", concept: "d:TurnoverRevenue" },
      { metric: "operating_profit", period: "2025-12-31", value: 82_803_000, printedText: "82,803", method: "ixbrl-tag", status: "tag-derived", concept: "d:OperatingProfitLoss" },
      { metric: "cash_at_bank", period: "2025-12-31", value: 2_334_000, printedText: "2,334", method: "ixbrl-tag", status: "tag-derived", concept: "d:CashBankOnHand" },
      { metric: "interest_payable", period: "2025-12-31", value: 10_292_000, printedText: "10,292", method: "ixbrl-tag", status: "tag-derived", concept: "d:InterestPayableSimilarChargesFinanceCosts" },
      { metric: "net_assets", period: "2025-12-31", value: 270_139_000, printedText: "270,139", method: "ixbrl-tag", status: "tag-derived", concept: "d:NetAssetsLiabilities" },
      { metric: "net_current_assets", period: "2025-12-31", value: -70_795_000, printedText: "70,795", method: "ixbrl-tag", status: "tag-derived", concept: "d:NetCurrentAssetsLiabilities" },
      // WP-BE13, keyed on 24 Sep 2026 by an agent reading the document's printed text and its tags,
      // before the maturity-band reader in lib/sources/ixbrl.ts existed. So these are "candidate",
      // not "tag-derived": an agent keyed them, no extractor did. Nobody has checked them.
      // Note 16, "Creditors: Amounts falling due after more than one year" (printed page 52), prints
      // "Secured loans 16,123" (£000). Note 15 (within one year) prints no loan line: trade creditors
      // 8,151, amounts owed to group undertakings 5,754, corporation tax -, other taxation 3,921,
      // other creditors 23,912, accruals and deferred income 28,163, lease liabilities 14,984, total
      // 84,885. So total borrowings, leases apart, are 16,123.
      { metric: "borrowings_total", period: "2025-12-31", value: 16_123_000, printedText: "16,123", scaleCaption: "£000", printedLabel: "Secured loans (creditors after more than one year)", noteRef: "16", method: "ixbrl-tag", status: "candidate", concept: "d:OtherRemainingBorrowings [Non-currentFinancialInstruments]" },
      // The strategic report's EBITDA reconciliation (printed page 1): "Operating profit 82,803 ...
      // Depreciation on tangible fixed assets 15,858, Depreciation of right of use assets 15,390,
      // Other (gains)/losses on the sale of tangible fixed assets (64), Amortisation of intangible
      // assets 51, Net reversal of impairment of tangible fixed assets (2,207), Net reversal of
      // impairment of right of use assets (1,322), EBITDA 110,509". Only the tangible depreciation and
      // the amortisation are tagged; the right-of-use depreciation is printed but not tagged.
      { metric: "depreciation_tangible", period: "2025-12-31", value: 15_858_000, printedText: "15,858", scaleCaption: "£000", printedLabel: "Depreciation on tangible fixed assets", method: "ixbrl-tag", status: "candidate", concept: "d:DepreciationExpensePropertyPlantEquipment" },
      { metric: "amortisation", period: "2025-12-31", value: 51_000, printedText: "51", scaleCaption: "£000", printedLabel: "Amortisation of intangible assets", method: "ixbrl-tag", status: "candidate", concept: "d:AmortisationExpenseIntangibleAssets" },
      { metric: "depreciation_right_of_use", period: "2025-12-31", value: 15_390_000, printedText: "15,390", scaleCaption: "£000", printedLabel: "Depreciation of right of use assets (printed, not tagged)", method: "ixbrl-tag", status: "candidate" },
      { metric: "ebitda_as_printed", period: "2025-12-31", value: 110_509_000, printedText: "110,509", scaleCaption: "£000", printedLabel: "EBITDA (the company's own definition, strategic report)", method: "ixbrl-tag", status: "candidate" },
    ],
    notes: "The one iXBRL filer in the audit sample (finding 17). Figures from extractFinancials on filing.xhtml (uk/tags.ts). printedText is the tagged text; the scale and sign come from the tag attributes (scale 3, and sign \"-\" on net current liabilities). Borrowings are tagged only by maturity (audit finding 9): WP-BE13 keyed them (candidate) and the extractor now sums the maturity bands.",
  },
  {
    key: "busy-bees-day-nurseries-2025-standin",
    companyNumber: "00861615",
    name: "BUSY BEES DAY NURSERIES LIMITED",
    transactionId: "MzUzODA1MDYzNGFkaXF6a2N4",
    madeUpDate: "2025-12-31",
    accountsType: "dormant",
    pageCount: 9,
    kind: "ixbrl",
    folder: "00861615-2025-12-31",
    filingType: "AA",
    scan: false,
    figures: [
      { metric: "net_assets", period: "2025-12-31", value: 1, printedText: "1", method: "ixbrl-tag", status: "tag-derived", concept: "d:NetAssetsLiabilities" },
      { metric: "current_assets", period: "2025-12-31", value: 1, printedText: "1", method: "ixbrl-tag", status: "tag-derived", concept: "d:CurrentAssets" },
      { metric: "total_assets_less_current_liabilities", period: "2025-12-31", value: 1, printedText: "1", method: "ixbrl-tag", status: "tag-derived", concept: "d:TotalAssetsLessCurrentLiabilities" },
      { metric: "shareholders_funds", period: "2025-12-31", value: 1, printedText: "1", method: "ixbrl-tag", status: "tag-derived", concept: "d:Equity" },
    ],
    notes: "STAND-IN for the second iXBRL filer; WP-BE17 must replace it. Dormant accounts with £1 of net assets, not a mid-size trading company. The brief allowed 20 CH lookups: Gymshark, Richer Sounds, Hotel Chocolat, Charles Tyrwhitt, Bettys & Taylors and Pure Gym all offered PDF only (18 lookups), and this sibling of Busy Bees Nurseries was the one iXBRL filing the last 2 lookups reached. It still exercises a second iXBRL document through the real parser.",
  },
  {
    key: "travelodge-hotels-2024-aamd",
    companyNumber: "00769170",
    name: "TRAVELODGE HOTELS LIMITED",
    transactionId: "MzQ2NTM4NzUzM2FkaXF6a2N4",
    madeUpDate: "2024-12-31",
    accountsType: "full",
    pageCount: 69,
    kind: "scan-full",
    folder: "00769170-2024-12-31",
    filingType: "AAMD",
    scan: true,
    figures: [
      {
        metric: "lease_liabilities_non_current", period: "2024-12-31", value: -2_578_600_000,
        printedText: "(2,578.6)", scaleCaption: "£m", pdfPage: 32, printedPage: "30",
        statement: "Balance sheet", printedLabel: "Lease liabilities (non-current liabilities)",
        noteRef: "21", method: "agent-read", status: "claude-checked", ties: [TL_BS], checks: PROVISIONAL, spotCheck: 4,
      },
      {
        // WP-BE23. RS-01 read the balance sheet by eye on Wed 23 Sep 2026: "CURRENT LIABILITIES
        // ... Lease liabilities 21 (89.7)". Not person-checked, and not in the part-1 spot check.
        metric: "lease_liabilities_current", period: "2024-12-31", value: -89_700_000,
        printedText: "(89.7)", scaleCaption: "£m", pdfPage: 32, printedPage: "30",
        statement: "Balance sheet", printedLabel: "Lease liabilities (current liabilities)",
        noteRef: "21", method: "agent-read", status: "tie-checked", ties: ["note 21: within one year 89.7 + after one year 2,578.6 = total 2,668.3"],
      },
      {
        // WP-BE23. RS-01 read note 21 by eye: "Closing Balance (2,668.3) ... Amounts falling due
        // within one year (89.7) Amounts falling after one year (2,578.6) Total (2,668.3)".
        metric: "lease_liabilities_total", period: "2024-12-31", value: -2_668_300_000,
        printedText: "(2,668.3)", scaleCaption: "£m", pdfPage: 56, printedPage: "54",
        statement: "21 Lease liabilities", printedLabel: "Total",
        noteRef: "21", method: "agent-read", status: "tie-checked", ties: ["note 21: within one year 89.7 + after one year 2,578.6 = total 2,668.3"],
      },
      {
        metric: "cash_at_bank", period: "2024-12-31", value: 221_500_000,
        printedText: "221.5", scaleCaption: "£m", pdfPage: 32, printedPage: "30",
        statement: "Balance sheet", printedLabel: "Cash and cash equivalents",
        noteRef: "18", method: "agent-read", status: "tie-checked", ties: [TL_BS],
      },
      {
        metric: "net_assets", period: "2024-12-31", value: 372_100_000,
        printedText: "372.1", scaleCaption: "£m", pdfPage: 32, printedPage: "30",
        statement: "Balance sheet", printedLabel: "Net assets",
        method: "agent-read", status: "tie-checked", ties: [TL_BS],
      },
    ],
    notes: "Amended accounts (AAMD, filed 7 May 2025) replacing the AA of 14 Apr 2025 for the same year end; the AMD is the newest accounts filing. IFRS 16 heavy: lease liabilities are the only debt-like line, with a further (89.7) current portion. No bank borrowings on the face of the balance sheet. PDF page = printed page + 2.",
  },
  {
    key: "matalan-retail-2026",
    companyNumber: "02103564",
    name: "MATALAN RETAIL LTD.",
    transactionId: "MzUzNzUwNjA4OGFkaXF6a2N4",
    madeUpDate: "2026-02-28",
    accountsType: "full",
    pageCount: 86,
    kind: "scan-full",
    folder: "02103564-2026-02-28",
    filingType: "AA",
    scan: true,
    figures: [
      {
        metric: "net_assets", period: "2026-02-28", value: -66_600_000,
        printedText: "(66.6)", scaleCaption: "£'m", pdfPage: 42, printedPage: "40",
        statement: "Statement of financial position", printedLabel: "Net liabilities",
        method: "agent-read", status: "claude-checked", ties: [MT_SFP], checks: PROVISIONAL, spotCheck: 5,
      },
      {
        metric: "cash_at_bank", period: "2026-02-28", value: 76_400_000,
        printedText: "76.4", scaleCaption: "£'m", pdfPage: 42, printedPage: "40",
        statement: "Statement of financial position", printedLabel: "Cash and cash equivalents",
        noteRef: "15", method: "agent-read", status: "tie-checked", ties: [MT_SFP],
      },
      {
        metric: "shareholder_loans", period: "2026-02-28", value: -286_000_000,
        printedText: "(286.0)", scaleCaption: "£'m", pdfPage: 42, printedPage: "40",
        statement: "Statement of financial position", printedLabel: "Loans from group undertakings (current liabilities)",
        noteRef: "17", method: "agent-read", status: "tie-checked", ties: [MT_SFP],
      },
    ],
    notes: "The scale caption is printed \"£'m\", a variant of £m. The 2025 column is marked Restated. Loans from group undertakings (286.0) are keyed as shareholder_loans because that is the nearest WP-BE01 key; they are intra-group debt, not a shareholder loan in the strict sense, and WP-BE17 should settle the definition. PDF page = printed page + 2.",
  },
  {
    key: "pizzaexpress-2024",
    companyNumber: "01404552",
    name: "PIZZAEXPRESS LIMITED",
    transactionId: "MzQ4MjMyMTE4OWFkaXF6a2N4",
    madeUpDate: "2024-12-29",
    accountsType: "full",
    pageCount: 26,
    kind: "scan-full",
    folder: "01404552-2024-12-29",
    filingType: "AA",
    scan: true,
    figures: [
      {
        metric: "cash_at_bank", period: "2024-12-29", value: 17_375_000,
        printedText: "17,375", scaleCaption: "£000", pdfPage: 9, printedPage: "6",
        statement: "Statement of financial position", printedLabel: "Cash and cash equivalents",
        noteRef: "14", method: "agent-read", status: "claude-checked", ties: [PE_SFP], checks: PROVISIONAL, spotCheck: 6,
      },
      {
        metric: "preference_shares", period: "2024-12-29", value: -110_000,
        printedText: "(110)", scaleCaption: "£000", pdfPage: 9, printedPage: "6",
        statement: "Statement of financial position", printedLabel: "Preference shares (non-current liabilities)",
        noteRef: "16", method: "agent-read", status: "tie-checked", ties: [PE_SFP],
      },
      {
        metric: "net_assets", period: "2024-12-29", value: -74_530_000,
        printedText: "(74,530)", scaleCaption: "£000", pdfPage: 9, printedPage: "6",
        statement: "Statement of financial position", printedLabel: "Net liabilities",
        method: "agent-read", status: "tie-checked", ties: [PE_SFP],
      },
    ],
    notes: "A second, small preference share case (£110k, note 16), shown inside non-current liabilities. Receivables of 1,123,072 are almost all intra-group; net liabilities (74,530). Comparative column is 31 December 2023. PDF page = printed page + 3.",
  },
  {
    key: "solid-state-2026",
    companyNumber: "00771335",
    name: "SOLID STATE PLC",
    transactionId: "MzUzNTQzMzAzOGFkaXF6a2N4",
    madeUpDate: "2026-03-31",
    accountsType: "group",
    pageCount: 140,
    kind: "scan-group",
    folder: "00771335-2026-03-31",
    filingType: "AA",
    scan: true,
    figures: [
      {
        metric: "borrowings_after_one_year", period: "2026-03-31", value: -10_142_000,
        printedText: "(10,142)", scaleCaption: "£'000", pdfPage: 93, printedPage: "91",
        statement: "Consolidated statement of financial position", printedLabel: "Non-current borrowings",
        noteRef: "19, 21, 22", method: "agent-read", status: "claude-checked", ties: [SS_SFP], checks: PROVISIONAL, spotCheck: 7,
      },
      {
        metric: "borrowings_within_one_year", period: "2026-03-31", value: -17_000,
        printedText: "(17)", scaleCaption: "£'000", pdfPage: 93, printedPage: "91",
        statement: "Consolidated statement of financial position", printedLabel: "Current borrowings",
        noteRef: "19, 21, 22", method: "agent-read", status: "tie-checked", ties: [SS_SFP],
      },
      {
        metric: "cash_at_bank", period: "2026-03-31", value: 6_568_000,
        printedText: "6,568", scaleCaption: "£'000", pdfPage: 93, printedPage: "91",
        statement: "Consolidated statement of financial position", printedLabel: "Cash and cash equivalents - available on demand",
        noteRef: "22", method: "agent-read", status: "tie-checked", ties: [SS_SFP],
      },
      {
        metric: "net_assets", period: "2026-03-31", value: 63_314_000,
        printedText: "63,314", scaleCaption: "£'000", pdfPage: 93, printedPage: "91",
        statement: "Consolidated statement of financial position", printedLabel: "Total net assets",
        method: "agent-read", status: "tie-checked", ties: [SS_SFP],
      },
      {
        metric: "facility_rcf_commitment", period: "2026-03-31", value: 15_000_000,
        printedText: "£15.0m", scaleCaption: "£m (in the sentence)", pdfPage: 117, printedPage: "115",
        statement: "Note 19 Bank borrowings and facilities (narrative)", printedLabel: "multi-currency RCF",
        noteRef: "19", method: "agent-read", status: "claude-checked", checks: PROVISIONAL, spotCheck: 10,
      },
      {
        metric: "borrowings_total", period: "2026-03-31", value: 10_159_000,
        printedText: "10,159", scaleCaption: "£'000", pdfPage: 117, printedPage: "115",
        statement: "Note 19 Bank borrowings and facilities", printedLabel: "Total borrowings",
        noteRef: "19", method: "agent-read", status: "tie-checked", ties: [SS_BORROW],
      },
    ],
    facilities: [
      {
        type: "revolving_credit_facility", nameAsPrinted: "multi-currency RCF", lender: "Lloyds Bank PLC and Comerica Bank",
        amount: 15_000_000, drawnAtPeriodEnd: 10_142_000, accordion: 10_000_000,
        maturity: "committed for three years from 18 May 2025, with two optional 12-month extension options",
        security: "fixed and floating charge over the assets of the Company and the Group", covenants: "leverage and debt service",
        pdfPage: 117, noteRef: "19", status: "candidate",
        quote: "On the 18th of May 2025 the Group refinanced the existing facilities with a new multi-currency RCF funded by Lloyds Bank PLC and Comerica Bank. The facility is for £15.0m and is committed for three years, with two optional 12-month extension options, and can be drawn in other optional currencies as well as pounds sterling (\"GBP\"). An additional accordion commitment of £10m can also be requested during the availability period.",
      },
      {
        type: "overdraft", nameAsPrinted: "multi-currency overdraft facility", amount: 5_000_000,
        pdfPage: 117, noteRef: "19", status: "candidate",
        quote: "The multi-currency overdraft facility of £5m remains in place as part of this agreement in addition to the potential for short-term working capital support for specific contracts by using a temporary net overdraft.",
      },
    ],
    notes: "AIM group, IFRS, £'000. The scan is soft; the ties confirm the digits read, and note 19 was read a second time at 170 dpi to confirm £15.0m. PDF page = printed page + 2. Note 19 (PDF page 117, found by local OCR page-finding) is \"Bank borrowings and facilities\". The RCF drawn at the year end is 10,142 (£'000) of the £15.0m commitment, plus 17 of accrued interest shown as a current borrowing. The £10m accordion is uncommitted and is not part of the facility amount.",
  },
];

// Printed arithmetic identities keyed by WP-BE17, as data. test/ukGold.test.ts recomputes every
// one and fails if `holds` does not match the arithmetic. Terms are in printed units with the
// printed sign. Part-1 ties stay as the description strings above.
export const UK_TIES: UkTie[] = [
  {
    id: "bw-note6-interest", caseKey: "bristol-water-2026", kind: "income-statement", pdfPages: [15, 9], scaleCaption: "£m", unit: 0.1,
    identities: [
      { terms: [["Interest income in respect of retirement benefit scheme", 0.8], ["Interest income on intercompany loans", 1.6]], total: ["subtotal", 2.4] },
      { terms: [["interest receivable", 2.4], ["Dividends on 8.75% irredeemable cumulative preference shares", -1.1]], total: ["Total net interest receivable and similar income (equals income statement net interest 1.3)", 1.3] },
    ],
    holds: true,
    note: "The only line under \"Less interest payable and similar charges\" is the preference dividend.",
  },
  {
    id: "bw-note13-borrowings", caseKey: "bristol-water-2026", kind: "borrowings", pdfPages: [20, 10], scaleCaption: "£m", unit: 0.1,
    identities: [
      { terms: [["Debentures", 1.6], ["8.75% irredeemable cumulative preference shares (note 16)", 12.5]], total: ["Total (equals SFP non-current liabilities 14.1)", 14.1] },
      { terms: [["£1,405,218 Consolidated debentures", 1.4], ["£36,740 perpetual debentures", 0], ["£54,875 perpetual debentures", 0.1], ["£72,900 perpetual debentures", 0.1], ["£12,500,000 cumulative preference shares", 12.5]], total: ["Total non- current loans and borrowings", 14.1] },
    ],
    holds: true,
  },
  {
    id: "bh-note21-bonds-split", caseKey: "boparan-holdings-2025", kind: "borrowings", pdfPages: [91], scaleCaption: "£m", unit: 0.1,
    identities: [
      { terms: [["Bond notes and other borrowings: Within one year or less or on demand", 7.5], ["More than one year but not more than five years", 381.6]], total: ["subtotal", 389.1] },
      { terms: [["bond notes and other borrowings", 389.1], ["Obligations under finance leases", 0.2]], total: ["Total borrowings (note 28)", 389.3] },
      { terms: [["Due within one year", 7.7], ["Due after more than one year", 381.6]], total: ["Total borrowings", 389.3] },
    ],
    holds: true,
    note: "7.7 due within one year is 7.5 of bonds and other borrowings plus 0.2 of finance leases.",
  },
  {
    id: "bh-note28-net-debt", caseKey: "boparan-holdings-2025", kind: "net-debt", pdfPages: [97], scaleCaption: "£m", unit: 0.1,
    identities: [
      { terms: [["Debt due within one year", -7.5], ["Debt due after more than one year", -381.6], ["Finance leases", -0.2]], total: ["Total borrowings (note 21)", -389.3] },
      { terms: [["Total borrowings", -389.3], ["Interest accrual", 7.5]], total: ["subtotal", -381.8] },
      { terms: [["subtotal", -381.8], ["Cash balances", 105.4]], total: ["Net debt", -276.4] },
    ],
    holds: true,
    note: "Net debt adds back the 7.5 bond interest accrual. \"Management monitor and view the net debt figure excluding prepaid fees and so it is added back into net debt in the table above.\"",
  },
  {
    id: "bh-net-debt-as-borrowings-less-cash", caseKey: "boparan-holdings-2025", kind: "net-debt", pdfPages: [91, 59, 97], scaleCaption: "£m", unit: 0.1,
    identities: [{ terms: [["Total borrowings", -389.3], ["Cash at bank and in hand", 105.4]], total: ["Net debt as printed", -276.4] }],
    holds: false,
    note: "The WP-BE05 form of the tie. Out by 7.5, which is exactly the printed interest accrual add-back on PDF page 97. Recorded so the definition is visible, not as a misread.",
  },
  {
    id: "pret-sub-sfp", caseKey: "pret-a-manger-2026", kind: "balance-sheet", pdfPages: [9], scaleCaption: "£'000", unit: 1,
    identities: [
      { terms: [["Trade and other receivables", 2], ["Cash and cash equivalents", 139]], total: ["Total current assets", 141] },
      { terms: [["Total non-current assets", 1_367_376], ["Total current assets", 141]], total: ["Total assets", 1_367_517] },
      { terms: [["Loans and borrowings", -123_591], ["Trade and other payables", -8_504], ["Derivatives", -3_197]], total: ["Total current liabilities", -135_292] },
      { terms: [["Loans and borrowings", -420_270], ["Trade and other payables", -52_734]], total: ["Total non-current liabilities", -473_004] },
      { terms: [["Total current liabilities", -135_292], ["Total non-current liabilities", -473_004]], total: ["Total liabilities", -608_296] },
      { terms: [["Total assets", 1_367_517], ["Total liabilities", -608_296]], total: ["Net assets", 759_221] },
      { terms: [["Share capital", 10_293], ["Share premium", 556_669], ["Retained earnings", 192_259]], total: ["Total equity and shareholder's funds", 759_221] },
    ],
    holds: true,
  },
  {
    id: "pret-parent-sfp", caseKey: "pret-a-manger-2026", kind: "balance-sheet", pdfPages: [42], scaleCaption: "£m", unit: 0.1,
    identities: [
      { terms: [["Property, plant and equipment", 66.3], ["Right-of-use assets", 352.3], ["Intangible assets and goodwill", 1023.5], ["Investment in joint venture", 0], ["Trade and other receivables", 8.2], ["Other non-current assets", 5.9], ["Deferred tax assets", 18.7]], total: ["Total non-current assets", 1474.9] },
      { terms: [["Inventories", 10.0], ["Trade and other receivables", 30.2], ["Cash and cash equivalents", 18.7], ["Assets held for sale", 0]], total: ["Total current assets", 58.9] },
      { terms: [["Total non-current assets", 1474.9], ["Total current assets", 58.9]], total: ["Total assets", 1533.8] },
      { terms: [["Loans and borrowings", -133.1], ["Lease liabilities", -103.4], ["Trade and other payables", -155.8], ["Other liabilities", -40.0], ["Income tax", -3.0], ["Provisions", -2.9], ["Derivatives", -3.2]], total: ["Total current liabilities", -441.4] },
      { terms: [["Loans and borrowings", -420.3], ["Lease liabilities", -322.6], ["Other liabilities", -20.8], ["Provisions", -7.9], ["Deferred tax liability", -32.8]], total: ["Total non-current liabilities", -804.4] },
      { terms: [["Total current liabilities", -441.4], ["Total non-current liabilities", -804.4]], total: ["Total liabilities", -1245.8] },
      { terms: [["Total assets", 1533.8], ["Total liabilities", -1245.8]], total: ["Net assets", 288.0] },
      { terms: [["Share capital", 0.3], ["Share premium", 837.8], ["Treasury shares", -7.2], ["Foreign currency translation reserve", -39.5], ["Retained earnings", -503.4]], total: ["Total equity", 288.0] },
    ],
    holds: true,
    note: "parent.pdf. Most decimal points do not render in this scan; these ties are what confirm the values.",
  },
  {
    id: "topps-pl", caseKey: "topps-tiles-2025", kind: "income-statement", pdfPages: [150], scaleCaption: "£'000", unit: 1,
    identities: [
      { terms: [["Group revenue", 295_754], ["Cost of sales", -141_428]], total: ["Gross profit", 154_326] },
      { terms: [["Gross profit", 154_326], ["Distribution and selling costs", -98_809], ["Other operating expenses", -6_232], ["Administrative costs", -27_215], ["Marketing and online costs", -9_459], ["Property related impairment reversals/(charges)", 2_425], ["Other income", 263]], total: ["Group operating profit/(loss)", 15_299] },
      { terms: [["Group operating profit/(loss)", 15_299], ["Finance income", 258], ["Finance costs", -7_295]], total: ["Profit/(loss) before taxation", 8_262] },
      { terms: [["Profit/(loss) before taxation", 8_262], ["Taxation", -2_274]], total: ["Profit/(loss) for the period", 5_988] },
    ],
    holds: true,
  },
  {
    id: "topps-sfp", caseKey: "topps-tiles-2025", kind: "balance-sheet", pdfPages: [151], scaleCaption: "£'000", unit: 1,
    identities: [
      { terms: [["Goodwill", 5_496], ["Intangible assets", 5_744], ["Property, plant and equipment", 16_776], ["Deferred tax assets", 1_339], ["Right-of-use assets", 77_947], ["Other financial assets", 1_302]], total: ["non-current assets", 108_604] },
      { terms: [["Inventories", 40_613], ["Other financial assets", 298], ["Trade and other receivables", 18_047], ["Current tax debtor", 1_588], ["Derivative financial instruments", 138], ["Cash and cash equivalents", 18_434], ["Assets classified as held for sale", 171]], total: ["current assets", 79_289] },
      { terms: [["non-current assets", 108_604], ["current assets", 79_289]], total: ["Total assets", 187_893] },
      { terms: [["Trade and other payables", -64_351], ["Lease liabilities", -16_782], ["Derivative financial instruments", 0], ["Provisions", -247]], total: ["current liabilities", -81_380] },
      { terms: [["current assets", 79_289], ["current liabilities", -81_380]], total: ["Net current (liabilities)/assets", -2_091] },
      { terms: [["current liabilities", -81_380], ["Lease liabilities", -83_010], ["Provisions", -4_776], ["Bank loans", -11_000]], total: ["Total liabilities", -180_166] },
      { terms: [["Total assets", 187_893], ["Total liabilities", -180_166]], total: ["Net assets", 7_727] },
      { terms: [["Share capital", 6_556], ["Share premium", 2_636], ["Own shares", -28], ["Merger reserve", -399], ["Share-based payment reserve", 6_563], ["Capital redemption reserve", 20_359], ["Accumulated losses", -27_960]], total: ["Total equity", 7_727] },
    ],
    holds: true,
  },
  {
    id: "topps-note18-cash", caseKey: "topps-tiles-2025", kind: "cash", pdfPages: [182, 151], scaleCaption: "£'000", unit: 1,
    identities: [{ terms: [["Sterling", 18_230], ["US dollar", 46], ["Euro", 158]], total: ["Total cash and cash equivalents (equals SFP)", 18_434] }],
    holds: true,
  },
  {
    id: "topps-leases", caseKey: "topps-tiles-2025", kind: "leases", pdfPages: [151, 183], scaleCaption: "£'000", unit: 1,
    identities: [{ terms: [["Lease liabilities, current (SFP)", 16_782], ["Lease liabilities, non-current (SFP)", 83_010]], total: ["Lease liabilities As at 27 September 2025 (note 19)", 99_792] }],
    holds: true,
  },
  {
    id: "topps-lease-roll", caseKey: "topps-tiles-2025", kind: "leases", pdfPages: [183], scaleCaption: "£'000", unit: 1,
    identities: [
      { terms: [["As at 28 September 2024", 85_965], ["Repayment of lease liabilities", -22_014], ["Non-cash movement - Lease additions and disposals", 29_716], ["Interest accrued on lease liabilities", 6_125]], total: ["As at 27 September 2025", 99_792] },
      { terms: [["Non-current borrowings As at 28 September 2024", 14_996], ["Proceeds from revolving credit facility", 21_000], ["Repayment of revolving credit facility", -25_000], ["Unamortised issue costs", 4]], total: ["Non-current borrowings As at 27 September 2025", 11_000] },
    ],
    holds: true,
  },
  {
    id: "topps-net-cash", caseKey: "topps-tiles-2025", kind: "net-debt", pdfPages: [154, 151], scaleCaption: "£ million (narrative)", unit: 0.1,
    identities: [
      { terms: [["cash and cash equivalents", 18.4], ["revolving credit facility draw down", -11.0]], total: ["adjusted net cash", 7.4] },
      { terms: [["drawn", 11.0], ["undrawn committed banking facilities", 19.0]], total: ["revolving credit facility", 30.0] },
    ],
    holds: true,
    note: "Leases are outside the company's adjusted net cash. With leases of 99.8 the same group is in net debt of about 92.4; that figure is not printed and is not keyed.",
  },
  {
    id: "jf-is", caseKey: "james-fisher-2025", kind: "income-statement", pdfPages: [124], scaleCaption: "£m", unit: 0.1,
    identities: [
      { terms: [["Revenue", 394.4], ["Cost of sales", -266.0]], total: ["Gross profit", 128.4] },
      { terms: [["Gross profit", 128.4], ["Administrative expenses", -110.4], ["Impairment charges", -0.2], ["Profit on disposal of businesses", 0], ["Refinancing costs", 0], ["Restructuring costs", -3.3], ["Share of post-tax results of joint ventures and associates", 1.6]], total: ["Operating profit", 16.1] },
      { terms: [["Operating profit", 16.1], ["Investment income", 2.6], ["Finance expense", -16.5], ["Net unrealised foreign exchange gain/(loss)", 2.1]], total: ["Profit before taxation", 4.3] },
      { terms: [["Profit before taxation", 4.3], ["Tax expense", -8.6]], total: ["(Loss)/profit for the year", -4.3] },
    ],
    holds: true,
  },
  {
    id: "jf-sfp", caseKey: "james-fisher-2025", kind: "balance-sheet", pdfPages: [126], scaleCaption: "£m", unit: 0.1,
    identities: [
      { terms: [["Goodwill", 65.4], ["Other intangible assets", 14.5], ["Property, plant and equipment", 104.0], ["Right-of-use assets", 101.2], ["Investment in joint ventures and associates", 6.6], ["Other investments", 1.4], ["Other receivables", 1.5], ["Other financial assets", 0.5], ["Deferred tax assets", 4.2], ["Retirement benefit surplus", 9.1]], total: ["Non-current assets", 308.4] },
      { terms: [["Inventories", 36.1], ["Trade and other receivables", 97.1], ["Other financial assets", 0.7], ["Cash and cash equivalents", 58.8], ["Current tax receivable", 3.9], ["Assets held for sale", 9.0]], total: ["Current assets", 205.6] },
      { terms: [["Trade and other payables", -102.2], ["Current tax payable", -3.4], ["Borrowings", -61.6], ["Other financial liabilities", 0], ["Provisions", -9.6], ["Liabilities associated with assets held for sale", -0.7]], total: ["Current liabilities", -177.5] },
      { terms: [["Current assets", 205.6], ["Current liabilities", -177.5]], total: ["Net current assets", 28.1] },
      { terms: [["Non-current assets", 308.4], ["Net current assets", 28.1]], total: ["Total assets less current liabilities", 336.5] },
      { terms: [["Other payables", -0.6], ["Borrowings", -141.3], ["Other financial liabilities", -0.3], ["Provisions", -4.7], ["Deferred tax liabilities", -0.7], ["Retirement benefit obligations", -1.6]], total: ["Non-current liabilities", -149.2] },
      { terms: [["Total assets less current liabilities", 336.5], ["Non-current liabilities", -149.2]], total: ["Net assets", 187.3] },
      { terms: [["Share capital", 12.7], ["Share premium", 27.6], ["Treasury shares", -0.5], ["Other reserves", -23.2], ["Retained earnings", 170.2], ["Non-controlling interests", 0.5]], total: ["Total equity", 187.3] },
    ],
    holds: true,
  },
  {
    id: "jf-note25-noncurrent", caseKey: "james-fisher-2025", kind: "borrowings", pdfPages: [170, 126], scaleCaption: "£m", unit: 0.1,
    identities: [{ terms: [["Bank borrowings", 70.8], ["Lease liabilities", 70.4], ["Cumulative preference shares", 0.1]], total: ["Borrowings (equals SFP non-current Borrowings)", 141.3] }],
    holds: true,
  },
  {
    id: "jf-note25-current", caseKey: "james-fisher-2025", kind: "borrowings", pdfPages: [170, 126], scaleCaption: "£m", unit: 0.1,
    identities: [{ terms: [["Bank overdrafts", 34.4], ["Bank borrowings", 7.0], ["Lease liabilities", 20.2]], total: ["Borrowings (equals SFP current Borrowings)", 61.6] }],
    holds: true,
  },
  {
    id: "jf-bank-total", caseKey: "james-fisher-2025", kind: "facility", pdfPages: [170], scaleCaption: "£m", unit: 0.1,
    identities: [
      { terms: [["Bank borrowings, non-current", 70.8], ["Bank borrowings, current", 7.0]], total: ["closing balance of the Group's bank borrowings (narrative)", 77.8] },
      { terms: [["drawn down under the RCF", 51.0], ["undrawn and available", 21.5]], total: ["total RCF", 72.5] },
    ],
    holds: true,
  },
  {
    id: "jf-net-debt", caseKey: "james-fisher-2025", kind: "net-debt", pdfPages: [147, 126], scaleCaption: "£m", unit: 0.1,
    identities: [
      { terms: [["Borrowings, current (SFP)", 61.6], ["Borrowings, non-current (SFP)", 141.3], ["Cash and cash equivalents (SFP)", -58.8]], total: ["Net borrowings (Note 25)", 144.1] },
      { terms: [["Lease liabilities under IFRS 16 (Note 16)", -90.6], ["IFRS 9 amortised cost adjustment", 0.2]], total: ["deduct subtotal", -90.4] },
      { terms: [["Lease liabilities under IAS 17", 0.7], ["Guarantees and collateral deposits", 6.6]], total: ["add subtotal", 7.3] },
      { terms: [["Net borrowings", 144.1], ["deduct", -90.4], ["add", 7.3]], total: ["Net debt - covenant basis", 61.0] },
    ],
    holds: true,
    note: "Net borrowings include the leases and the preference shares, because the balance sheet Borrowings lines do. The covenant takes the IFRS 16 leases out and puts 0.7 of old finance leases and 6.6 of guarantees back. The company's own \"Net debt 54.4\" (strategic report, PDF page 66, seen only in local OCR) would be 144.1 - 90.4 + 0.7; it was not read by eye and is not keyed.",
  },
  {
    id: "jf-leases", caseKey: "james-fisher-2025", kind: "leases", pdfPages: [170, 147], scaleCaption: "£m", unit: 0.1,
    identities: [{ terms: [["Lease liabilities, non-current (note 25)", 70.4], ["Lease liabilities, current (note 25)", 20.2]], total: ["Lease liabilities under IFRS 16 (note 5.3)", 90.6] }],
    holds: true,
  },
  {
    id: "tesco-bs", caseKey: "tesco-scan-2026", kind: "balance-sheet", pdfPages: [125], scaleCaption: "£m", unit: 1,
    identities: [
      { terms: [["Trade and other payables", -10_746], ["Borrowings", -1_824], ["Lease liabilities", -659], ["Provisions", -273], ["Insurance contract liabilities", -772], ["Derivative financial instruments", -48], ["Current tax liabilities", -7]], total: ["current liabilities", -14_329] },
      { terms: [["current assets incl. held for sale", 8_483], ["current liabilities", -14_329]], total: ["Net current liabilities", -5_846] },
      { terms: [["Trade and other payables", -42], ["Borrowings", -5_372], ["Lease liabilities", -7_225], ["Provisions", -164], ["Derivative financial instruments", -123], ["Post-employment benefit deficit", -127], ["Deferred tax liabilities", -635]], total: ["non-current liabilities", -13_688] },
      { terms: [["non-current assets", 30_991], ["Net current liabilities", -5_846], ["non-current liabilities", -13_688]], total: ["Net assets", 11_457] },
      { terms: [["Equity attributable to owners of the parent", 11_463], ["Non-controlling interests", -6]], total: ["Total equity", 11_457] },
    ],
    holds: true,
  },
  {
    id: "tesco-esef-borrowings", caseKey: "tesco-scan-2026", kind: "cross-source", pdfPages: [125], scaleCaption: "£m", unit: 1,
    identities: [{ terms: [["scan: Borrowings, current", 1_824], ["scan: Borrowings, non-current", 5_372]], total: ["ESEF LongtermBorrowings + ShorttermBorrowings (tesco-esef-2026 borrowings_total)", 7_196] }],
    holds: true,
  },
  {
    id: "tesco-esef-cash", caseKey: "tesco-scan-2026", kind: "cross-source", pdfPages: [125], scaleCaption: "£m", unit: 1,
    identities: [{ terms: [["scan: Cash and cash equivalents", 2_515]], total: ["ESEF CashAndCashEquivalents", 2_515] }],
    holds: true,
  },
];
