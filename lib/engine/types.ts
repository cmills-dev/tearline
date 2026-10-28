// lib/engine/types.ts
// The Fact Manifest is the product. A tear sheet is a data structure first and a
// document second. Every number that ever reaches a reader's eye is a Fact with an
// id, a provenance chain, a resolution rung and a verification state. Prose (the
// "language plane") may only REFERENCE these ids; it can never originate a number.

import type { AccountsTypeLabel } from "../resolve/accountsType";

// ---------------------------------------------------------------------------
// Resolution ladder
// ---------------------------------------------------------------------------
// Every field resolves through a labelled ladder. The word "reported" is reserved
// for R1 only. Lower rungs are honest about the substitution they made.

export type Rung = "R1" | "R2" | "R3" | "R4";

export const RUNG_META: Record<
  Rung,
  { code: Rung; label: string; short: string; blurb: string }
> = {
  R1: {
    code: "R1",
    label: "REPORTED",
    short: "Reported",
    blurb: "Taken verbatim from a filed source. No transformation applied.",
  },
  R2: {
    code: "R2",
    label: "SYNTHESISED",
    short: "Synthesised",
    blurb: "Computed from reported facts via a declared, auditable formula.",
  },
  R3: {
    code: "R3",
    label: "PROXY",
    short: "Proxy",
    blurb:
      "A related figure stands in for the requested one. Direction of bias is flagged.",
  },
  R4: {
    code: "R4",
    label: "ABSTAIN",
    short: "Abstain",
    blurb:
      "No defensible value available from entitled sources. Attempt log retained.",
  },
};

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------
// A provenance tag marks the class of source. [Acc] filed accounts, [Web] public
// web, [NF] the Companies House network / filing history API.

export type ProvenanceTag = "Acc" | "Web" | "NF" | "Reg";

export interface Provenance {
  sourceId: string; // stable id of the underlying source document
  tag: ProvenanceTag;
  documentName: string; // e.g. "Annual report and accounts, y/e 31 Dec 2024"
  locator: string; // page / note / section reference, e.g. "Note 4, p.18"
  snippet: string; // exact rendered text as it appears in the source
  retrievedAt: string; // ISO date the source was captured
  contentHash: string; // hash of the snippet, computed at ingest, read at view time
  // --- The provenance envelope (optional, additive). The frozen contract only requires the
  // fields above; these enrich a fact for the export-policy engine and staleness reporting.
  // Defaults when absent: entitlement "public", tier "T0", asOf falls back to retrievedAt.
  asOf?: string; // the data's effective / as-reported date, distinct from retrievedAt (capture)
  entitlement?: "public" | "entitled" | "client"; // the export-policy plane
  tier?: "T0" | "entitled" | "client"; // Tier-0 shared vs a tenant silo
  confidence?: number; // extraction confidence, 0..1 (R1 reported facts are 1)
  // --- How the figure was read (WP-BE05). A scan has no text layer to quote, so a figure read
  // off a page image says so, names the page and the characters printed on it, and carries the
  // tags that earned it a place on the sheet. "double-read" is REQUIRED for a scan-read fact to
  // hold a value at any rung: the ladder and the engine verifier both turn one without it into
  // an abstention. "tie-pass" is added when a printed arithmetic tie ran and held.
  kind?: ProvenanceKind;
  page?: number; // 1-based page index in the source PDF
  printedText?: string; // the figure exactly as printed, brackets included
  tags?: ScanReadTag[];
  // --- Whose figure this is (WP-BE19). Written by lib/engine/figureBasis.ts on every figure a
  // run holds, and read as-is by the sheet, the evidence card, the exports and any print route:
  // none of them rebuilds the sentence. It lives on the provenance, not the fact, because an
  // abstained figure has no provenance, so it cannot carry a label that implies it survived.
  basis?: FigureBasis;
}

// Whose figures a sheet shows, per figure. A subsidiary's sheet may be built from its parent's
// group accounts (WP-BE12), and then every figure on it is the parent group's, never the
// subsidiary's. `audit` is never "audited": the engine does not read the auditor's report, so it
// says only what the register's accounts type establishes.
export interface FigureBasis {
  kind: "parent-group" | "own";
  // The company whose filing the figure came from.
  entity: { number: string; name: string };
  // The company the sheet was asked for. Differs from `entity` only on a parent-group sheet.
  subject: { number: string; name: string };
  // Where on the record the figure sits: the accounts filing, the register, or a formula over
  // figures that carry this same basis.
  from: "accounts" | "register" | "derived";
  // The filing in words, e.g. "AA group accounts made up to 2025-12-28, filed 2026-06-25,
  // transaction MzQ5...".
  filing: string;
  audit: "exempt" | "not-checked";
  exemption?: string; // e.g. "the subsidiary audit exemption (Companies Act 2006, section 479A)"
  text: string; // the full sentence every surface prints
}

export type ProvenanceKind = "scan-read";
// "period-from-header-row" (WP-BE22): the column heading printed no year, and the period was
// established from a header row of the same table above it. It is a note for the reader, never
// a qualification: the figure passed every check a figure under a dated heading passes.
export type ScanReadTag = "double-read" | "tie-pass" | "period-from-header-row";

// A scan-read figure may hold a value only when two independent reads agreed on it. There is no
// flag that relaxes this.
export function scanReadAdmissible(p: Provenance | null | undefined): boolean {
  if (!p || p.kind !== "scan-read") return true;
  return (
    Array.isArray(p.tags) &&
    p.tags.includes("double-read") &&
    Number.isInteger(p.page) &&
    (p.page ?? 0) >= 1 &&
    typeof p.printedText === "string" &&
    p.printedText.length > 0
  );
}

// ---------------------------------------------------------------------------
// Derivation (how a synthesised or proxied value was produced)
// ---------------------------------------------------------------------------

export interface Derivation {
  formula: string; // human-readable, e.g. "EBITDA = EBIT + Depreciation & amortisation"
  inputs: string[]; // fact ids consumed
  note?: string; // any assumption worth surfacing
}

// A proxy substitution: what was asked for vs what was supplied, and which way the
// resulting number is likely to err.
export interface ProxyInfo {
  requested: string; // the metric the reader asked for, e.g. "EBITDA"
  suppliedAs: string; // what actually stands in, e.g. "EBIT (Operating profit)"
  biasDirection: "understates" | "overstates" | "indeterminate";
  biasNote: string;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------
// Honest labels only. A single unchecked source is never "verified".

export type VerificationStatus =
  | "STRUCTURAL_PASS" // passed a cross-field identity (e.g. assets = liab + equity)
  | "STRUCTURAL_FAIL" // an identity did not hold; surfaced, not hidden
  | "SINGLE_SOURCE" // taken from one source, no independent check available
  | "DERIVED" // internally consistent by construction (a synthesised value)
  | "NOT_APPLICABLE";

export interface VerificationState {
  status: VerificationStatus;
  checks: VerificationCheck[];
}

export interface VerificationCheck {
  id: string;
  label: string; // e.g. "Balance sheet identity"
  identity: string; // e.g. "total assets = total liabilities + total equity"
  passed: boolean;
  detail: string; // the arithmetic actually performed, in numbers
}

// ---------------------------------------------------------------------------
// Fact
// ---------------------------------------------------------------------------

export type FactValueKind = "currency" | "ratio" | "count" | "percent" | "text";

export interface Fact {
  id: string; // canonical id, e.g. "ebitda.FY2024"
  metric: string; // canonical metric key, e.g. "ebitda"
  label: string; // display label, e.g. "EBITDA"
  period: string; // e.g. "FY2024" or "As at 31 Dec 2024"
  kind: FactValueKind;
  // value is null only at R4 (abstain). Numbers live here and nowhere else.
  value: number | string | null;
  unit: string; // e.g. "GBP", "x", "FTE", "%"
  rung: Rung;
  provenance: Provenance | null; // null at R4
  derivation?: Derivation; // present at R2 (and R3 when the proxy was itself computed)
  proxy?: ProxyInfo; // present at R3
  verification: VerificationState;
  attemptLog?: AttemptLogEntry[]; // present at R3/R4 to show what was tried
  // The printed precision of a reported figure, when the source says or shows it. Sets the
  // rounding tolerance of the structural checks (lib/engine/precision.ts). Absent on fixtures,
  // derived figures and text facts, which keep the flat tolerance.
  precision?: FactPrecision;
}

export interface FactPrecision {
  unit: number; // what one unit of the last printed digit is worth, in the fact's currency units
  basis: "decimals" | "printed" | "value"; // the XBRL decimals attribute, the printed figure, or the value alone
}

export interface AttemptLogEntry {
  step: string; // which rung / route was attempted
  outcome: "found" | "missing" | "insufficient";
  detail: string;
}

// ---------------------------------------------------------------------------
// Evidence card (pre-rendered; the viewer reads it, never rebuilds it)
// ---------------------------------------------------------------------------

export interface EvidenceCard {
  factId: string;
  metricLabel: string;
  period: string;
  displayValue: string; // the formatted value shown on the sheet
  rung: Rung;
  rungLabel: string;
  provenance: Provenance | null;
  derivation?: Derivation;
  proxy?: ProxyInfo;
  verification: VerificationState;
  attemptLog?: AttemptLogEntry[];
  contentHash: string; // card-level hash, computed at assemble time
}

// ---------------------------------------------------------------------------
// Fact manifest (the whole borrower, as a typed structure)
// ---------------------------------------------------------------------------

export interface EntityMeta {
  companyName: string; // includes the "(illustrative)" stamp for synthetic borrowers
  companyNumber: string;
  jurisdiction: string;
  status: string; // e.g. "active"
  incorporatedOn: string;
  sicCodes: string[];
  registeredOffice: string;
  // The Companies House accounts type, in the resolver's vocabulary
  // (lib/resolve/accountsType.ts AccountsTypeLabel). It used to be three values, which called
  // every group, small, dormant and audit-exempt filing "filleted" (audit finding 8).
  accountsType: AccountsTypeLabel;
  latestPeriodEnd: string;
  synthetic: boolean; // true => illustrative demo borrower
  lei?: string; // Legal Entity Identifier, when resolved (GLEIF); the cross-source join key
  ultimateParentLei?: string;
  // The as-reported / FILING date of the accounts this manifest was built from (YYYY-MM-DD), when a
  // connector can supply it (SEC exposes a per-fact `filed` date). Drives restatement precedence in
  // the KB: a later filing that restates the same period supersedes its original. Absent it, the KB
  // falls back to the manifest capture time, which cannot distinguish a restatement from a re-fetch.
  asReportedAt?: string;
}

export interface FactManifest {
  entity: EntityMeta;
  facts: Record<string, Fact>; // keyed by fact id
  sources: Record<string, SourceDocument>; // keyed by sourceId
  generatedAt: string;
  // The facilities table read from the debt note of a scanned filing (WP-BE16). Absent when no
  // scan was read; present with status "abstain" and a reason when one was read and it could not
  // be shown.
  capitalStructure?: CapitalStructure;
}

// ---------------------------------------------------------------------------
// Capital structure from the debt note (WP-BE16)
// ---------------------------------------------------------------------------
// One row per facility printed in the borrowings note, in the order the note prints them. Every
// cell is one of three things: words or a figure both reads agreed on, with the page they are on;
// "not printed", when neither read found it; or an abstention with its reason. Nothing is worked
// out. There is no fulcrum and no seniority order: the ranking cell holds only the note's own
// words on ranking, and the rows are never sorted by them. Registered charges are not here; they
// stay on the sheet as charges, from the charges register, and say nothing about ranking.

export type FacilityCellStatus = "agreed" | "not-printed" | "abstain";

export interface FacilityCell {
  status: FacilityCellStatus;
  text: string | null; // agreed: the words or figure as printed; otherwise null
  // Amounts only: the agreed figure in pounds, the printed scale applied. Null for a text cell,
  // for an amount the note prints as words ("undrawn", "nil"), and whenever the cell is not agreed.
  pounds: number | null;
  nil?: boolean; // an amount the note prints as nil or undrawn, shown as the words, never as 0
  page: number | null; // the PDF page the first read cited for the row
  reason: string | null; // why the cell is not printed or abstains
}

export const FACILITY_CELL_KEYS = ["drawn", "committed", "maturity", "rateOrMargin", "security", "lender", "ranking"] as const;
export type FacilityCellKey = (typeof FACILITY_CELL_KEYS)[number];

export interface FacilityRow {
  id: string;
  status: "found" | "abstain";
  name: string | null; // the facility's name as the first read printed it
  type: string | null; // term_loan, revolving_credit_facility, notes_or_bonds, overdraft, shareholder_loan, other
  page: number | null;
  cells: Record<FacilityCellKey, FacilityCell>;
  citation: string; // page, note heading and what the two reads agreed
  reason: string | null; // set when the row abstains
}

export interface CapitalStructure {
  status: "found" | "abstain";
  reason: string | null; // set when the whole table abstains
  verifier: string; // e.g. "facility-read/v1"
  transactionId: string;
  pages: number[]; // the debt-note pages both reads were given
  noteHeading: string | null;
  scaleCaption: string | null; // the unit caption printed at the head of the note, if any
  rows: FacilityRow[];
  notes: string[]; // plain lines on what was left out and why
  // Always false. Kept on the record so every consumer can see the engine made no fulcrum call.
  fulcrumStated: false;
  // Whose table this is, set by the basis label pass (lib/engine/figureBasis.ts), as on a figure.
  basis?: FigureBasis;
}

// A source document as ingested. The snippet library lives here so evidence cards
// can be assembled deterministically.
export interface SourceDocument {
  sourceId: string;
  tag: ProvenanceTag;
  documentName: string;
  retrievedAt: string;
  origin: string; // e.g. "Companies House filing history" or "fixture"
}
