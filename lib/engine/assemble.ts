// lib/engine/assemble.ts
// Assembles a FactManifest into a TearSheet VIEW MODEL: pre-rendered evidence cards,
// key-figure tiles, a period financials table, the capital-structure block, a ladder
// summary and a verification summary, plus the ProseGate-clean narrative. Evidence is
// rendered HERE, once; the viewer only READS the cards, it never reconstructs them.

import type { BorrowerFixture } from "../sources/fixtures/types";
import { contentHash } from "./hash";
import { BLANK, displayFor, formatValue } from "../format/format";
import { buildNarrative } from "./languagePlane";
import type {
  CapitalStructure,
  EvidenceCard,
  Fact,
  FactValueKind,
  FactManifest,
  ProvenanceTag,
  Rung,
  VerificationCheck,
} from "./types";
import { RUNG_META } from "./types";
import { csvCell } from "../references/csv";

export interface FigureTile {
  factId: string;
  label: string;
  display: string;
  rung: Rung;
  isFulcrumFigure?: boolean; // gets the single maroon accent
}

export interface TableCell {
  factId: string | null;
  display: string;
  rung: Rung | null;
}

// A year-on-year delta between the latest period and the prior period. Computed in
// code, only when BOTH periods are real resolved values (R1/R2/R3). Never computed
// across an R4 abstain: an honest, labelled blank is shown instead.
export interface DeltaCell {
  status: "computed" | "abstain" | "single-period";
  absDisplay: string; // signed, unit-aware, e.g. "+£4.4m" or BLANK
  pctDisplay: string; // signed percentage, e.g. "+10.0%" or BLANK
  direction: "up" | "down" | "flat" | "none";
  isFulcrum: boolean; // the single most important figure gets the maroon accent
  note?: string; // why a delta could not be computed
}

export interface TableRow {
  metric: string;
  label: string;
  cells: TableCell[]; // one per period column
  delta: DeltaCell; // latest vs prior period
}
export interface FinancialsTable {
  periodLabels: string[];
  latestLabel: string;
  priorLabel: string | null;
  rows: TableRow[];
}

// A single row of the model export (one per fact in the manifest). Every row traces
// back to real fact data; abstained metrics export with an empty value and rung R4.
export interface ExportRow {
  metric: string;
  label: string;
  period: string;
  value: string; // raw stored value; empty string at R4
  unit: string;
  rung: Rung;
  verificationStatus: string;
  sourceDocument: string;
  sourceLocator: string;
  contentHash: string;
}

// A figure a source passage backs, cross-referenced in the Sources panel.
export interface ReferenceFigure {
  factId: string;
  label: string;
  period: string;
  rung: Rung;
  contentHash: string; // hash of this exact cited passage, as at ingest
}

// One distinct cited passage (document + locator), consolidated across every figure
// it backs. This is the hyperlinked references output the product promises.
export interface Reference {
  citation: number; // sequential [1], [2], ...
  tag: ProvenanceTag;
  documentName: string;
  locator: string;
  backs: ReferenceFigure[];
}

export interface CapitalRow {
  id: string;
  name: string;
  rank: string;
  provider: string;
  security: string;
  factId: string | null;
  display: string;
  // The resolved amount itself, for the workbook. The display is rounded to one decimal place,
  // and parsing it back put a number no filing printed into the Capital sheet (WP-QA03 N6).
  value: number | null;
  unit: string | null;
  rung: Rung | null;
  isFulcrum: boolean;
}

export interface LadderSummary {
  counts: Record<Rung, number>;
  total: number;
}

export interface VerificationSummary {
  checks: VerificationCheck[];
  passed: number;
  failed: number;
}

export interface TearSheet {
  entity: FactManifest["entity"];
  thesis: string;
  primaryPeriod: string;
  narrative: string[];
  tiles: FigureTile[];
  financials: FinancialsTable;
  capital: CapitalRow[];
  // The facilities table from the debt note (WP-BE16). Null when no scanned debt note was read;
  // a table with status "abstain" says why it is not shown.
  facilities: CapitalStructure | null;
  evidence: Record<string, EvidenceCard>;
  ladder: LadderSummary;
  verification: VerificationSummary;
  references: Reference[];
  exportRows: ExportRow[];
  exportFilename: string;
  sourceCount: number;
}

function evidenceFor(fact: Fact): EvidenceCard {
  const display = displayFor(fact);
  const hashInput = [
    fact.id,
    fact.rung,
    display,
    fact.provenance?.contentHash ?? "no-source",
    fact.derivation?.formula ?? "",
    fact.proxy?.suppliedAs ?? "",
  ].join("|");
  return {
    factId: fact.id,
    metricLabel: fact.label,
    period: fact.period,
    displayValue: display,
    rung: fact.rung,
    rungLabel: RUNG_META[fact.rung].label,
    provenance: fact.provenance,
    derivation: fact.derivation,
    proxy: fact.proxy,
    verification: fact.verification,
    attemptLog: fact.attemptLog,
    contentHash: contentHash(hashInput),
  };
}

// A signed, unit-aware rendering of a delta. Formatting never invents a value; it
// only renders the arithmetic already done in code.
function signedValue(delta: number, kind: FactValueKind, unit: string): string {
  if (delta === 0) return formatValue(0, kind, unit);
  const sign = delta > 0 ? "+" : "−";
  return sign + formatValue(Math.abs(delta), kind, unit);
}

function signedPct(pct: number | null): string {
  if (pct === null) return "n/a";
  if (pct === 0) return "0.0%";
  const sign = pct > 0 ? "+" : "−";
  const r = Math.round(Math.abs(pct) * 10) / 10;
  return `${sign}${r.toFixed(1)}%`;
}

// Year-on-year delta. Only real resolved values on BOTH sides produce a number; an
// R4 abstain (or a missing prior period) yields a labelled blank, never a guess.
export function computeDelta(
  latestFact: Fact | undefined,
  priorFact: Fact | undefined,
  hasPrior: boolean,
  isFulcrum: boolean
): DeltaCell {
  const blank = (
    status: DeltaCell["status"],
    note: string
  ): DeltaCell => ({
    status,
    absDisplay: BLANK,
    pctDisplay: BLANK,
    direction: "none",
    isFulcrum,
    note,
  });
  if (!hasPrior) return blank("single-period", "Only one period on file.");
  if (!latestFact || !priorFact)
    return blank("single-period", "No comparable prior-period figure.");
  if (
    latestFact.rung === "R4" ||
    priorFact.rung === "R4" ||
    typeof latestFact.value !== "number" ||
    typeof priorFact.value !== "number"
  ) {
    return blank(
      "abstain",
      "A period abstained (R4); no delta is computed across an abstain."
    );
  }
  // Never subtract across a UNIT change: two figures in different units (e.g. a reporting-currency
  // switch GBP->USD, or a currency figure against a ratio) do not form a meaningful delta. Abstain
  // with a note rather than emit a nonsense number.
  if ((latestFact.unit || "") !== (priorFact.unit || "")) {
    return blank(
      "abstain",
      `Units differ between periods (${latestFact.unit || "?"} vs ${priorFact.unit || "?"}); no delta across a unit change.`,
    );
  }
  const abs = latestFact.value - priorFact.value;
  // Over the prior's magnitude, so the % has the sign of the change: -100 to +50 is +150%, not
  // -150% beside an "up" arrow (WP-QA03 N5).
  const pct = priorFact.value !== 0 ? (abs / Math.abs(priorFact.value)) * 100 : null;
  const direction: DeltaCell["direction"] =
    abs > 0 ? "up" : abs < 0 ? "down" : "flat";
  // A delta between two DIFFERENT rungs (e.g. an R1 reported latest against an R3 proxy prior) is
  // computed but flagged, so the reader knows the comparison spans a reported figure and a proxy.
  const rungNote = latestFact.rung !== priorFact.rung
    ? `Delta spans different rungs (${latestFact.rung} vs ${priorFact.rung}); the change inherits the weaker rung's basis.`
    : undefined;
  return {
    status: "computed",
    absDisplay: signedValue(abs, latestFact.kind, latestFact.unit),
    pctDisplay: signedPct(pct),
    direction,
    isFulcrum,
    ...(rungNote ? { note: rungNote } : {}),
  };
}

// Consolidate every distinct cited passage (document + locator) and cross-reference
// it to the figures it backs. Derived lines (no external source) and abstains (no
// source) are excluded; they carry no citable passage of their own.
export function buildReferences(facts: Record<string, Fact>): Reference[] {
  const map = new Map<string, Reference>();
  for (const fact of Object.values(facts)) {
    const p = fact.provenance;
    if (!p) continue; // R4 abstain: nothing to cite
    if (p.sourceId === "derived") continue; // synthesised line, cites its inputs
    const key = `${p.sourceId}|${p.documentName}|${p.locator}`;
    let ref = map.get(key);
    if (!ref) {
      ref = {
        citation: 0,
        tag: p.tag,
        documentName: p.documentName,
        locator: p.locator,
        backs: [],
      };
      map.set(key, ref);
    }
    if (!ref.backs.some((b) => b.factId === fact.id)) {
      ref.backs.push({
        factId: fact.id,
        label: fact.label,
        period: fact.period,
        rung: fact.rung,
        contentHash: p.contentHash,
      });
    }
  }
  const refs = [...map.values()].sort((a, b) =>
    a.documentName !== b.documentName
      ? a.documentName < b.documentName
        ? -1
        : 1
      : a.locator < b.locator
        ? -1
        : a.locator > b.locator
          ? 1
          : 0
  );
  for (const r of refs) {
    r.backs.sort((a, b) =>
      a.period !== b.period
        ? a.period < b.period
          ? 1
          : -1
        : a.label < b.label
          ? -1
          : a.label > b.label
            ? 1
            : 0
    );
  }
  refs.forEach((r, i) => (r.citation = i + 1));
  return refs;
}

// One export row per fact. Deterministic order by fact id. Abstains export honestly
// (empty value, rung R4) rather than being hidden.
export function buildExportRows(
  facts: Record<string, Fact>,
  evidence: Record<string, EvidenceCard>
): ExportRow[] {
  return Object.values(facts)
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((fact) => ({
      metric: fact.metric,
      label: fact.label,
      period: fact.period,
      value: fact.value === null ? "" : String(fact.value),
      unit: fact.unit,
      rung: fact.rung,
      verificationStatus: fact.verification.status,
      sourceDocument: fact.provenance?.documentName ?? "",
      sourceLocator: fact.provenance?.locator ?? "",
      contentHash: evidence[fact.id]?.contentHash ?? "",
    }));
}

const EXPORT_HEADERS = [
  "metric",
  "label",
  "period",
  "value",
  "unit",
  "rung",
  "verification_status",
  "source_document",
  "source_locator",
  "content_hash",
] as const;

// RFC 4180 style CSV. Fields with a comma, quote or newline are quoted and any quote
// is doubled. Rows are CRLF-terminated so spreadsheets read them cleanly. A cell that a
// spreadsheet would read as a formula is written as text (lib/references/csv.ts, WP-BE11):
// document names and locators come from filings and are not trusted.
export function toCsv(rows: ExportRow[]): string {
  const esc = csvCell;
  const lines = [EXPORT_HEADERS.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.metric,
        r.label,
        r.period,
        r.value,
        r.unit,
        r.rung,
        r.verificationStatus,
        r.sourceDocument,
        r.sourceLocator,
        r.contentHash,
      ]
        .map(esc)
        .join(",")
    );
  }
  return lines.join("\r\n");
}

export function assembleTearSheet(
  manifest: FactManifest,
  fixture: BorrowerFixture
): TearSheet {
  const f = manifest.facts;
  const primary = fixture.periods.find((p) => p.isLatest) ?? fixture.periods[0];
  const primaryKey = primary.key;

  // Evidence cards for every fact.
  const evidence: Record<string, EvidenceCard> = {};
  for (const fact of Object.values(f)) evidence[fact.id] = evidenceFor(fact);

  // Key-figure tiles. Leverage is the single most important figure -> maroon accent.
  const tileMetrics: { metric: string; fulcrum?: boolean }[] = [
    { metric: "turnover" },
    { metric: "ebitda" },
    // Net debt prints twice where the source reads leases, including leases first (WP-BE23,
    // Cam 24 Sep 2026). A source that reads no lease line has no such fact, so no tile.
    { metric: "netDebtIncludingLeases" },
    { metric: "netDebt" },
    { metric: "leverage", fulcrum: true },
  ];
  const tiles: FigureTile[] = [];
  for (const t of tileMetrics) {
    const fact = f[`${t.metric}.${primaryKey}`];
    if (!fact) continue;
    tiles.push({
      factId: fact.id,
      label: fact.label,
      display: displayFor(fact),
      rung: fact.rung,
      isFulcrumFigure: t.fulcrum,
    });
  }

  // Financials table across all periods.
  const financialRows = [
    "turnover",
    "operatingProfit",
    "ebitda",
    "netInterest",
    "cash",
    "borrowings",
    "leaseLiabilitiesTotal",
    "netDebtIncludingLeases",
    "netDebt",
    "totalAssets",
    "totalLiabilities",
    "totalEquity",
    "leverage",
    "interestCover",
  ];
  const periodLabels = fixture.periods.map((p) => p.key);
  // Latest vs prior period, for the year-on-year trend column.
  const latestPeriod =
    fixture.periods.find((p) => p.isLatest) ?? fixture.periods[0];
  const priorPeriod =
    fixture.periods
      .filter((p) => p.key !== latestPeriod.key)
      .sort((a, b) => (a.end < b.end ? 1 : a.end > b.end ? -1 : 0))[0] ?? null;
  const rows: TableRow[] = [];
  for (const metric of financialRows) {
    const cells: TableCell[] = [];
    let anyPresent = false;
    let label = metric;
    for (const p of fixture.periods) {
      const fact = f[`${metric}.${p.key}`];
      if (fact) {
        anyPresent = true;
        label = fact.label;
        cells.push({ factId: fact.id, display: displayFor(fact), rung: fact.rung });
      } else {
        cells.push({ factId: null, display: BLANK, rung: null });
      }
    }
    if (anyPresent) {
      const latestFact = f[`${metric}.${latestPeriod.key}`];
      const priorFact = priorPeriod
        ? f[`${metric}.${priorPeriod.key}`]
        : undefined;
      const delta = computeDelta(
        latestFact,
        priorFact,
        !!priorPeriod,
        metric === "leverage" // leverage is the single most important figure
      );
      rows.push({ metric, label, cells, delta });
    }
  }
  const financials: FinancialsTable = {
    periodLabels,
    latestLabel: latestPeriod.key,
    priorLabel: priorPeriod ? priorPeriod.key : null,
    rows,
  };

  // Capital structure block.
  const capital: CapitalRow[] = fixture.capitalStructure.map((t) => {
    const fact = f[`${t.metric}.${primaryKey}`];
    return {
      id: t.id,
      name: t.name,
      // A real filing's tranche states no ranking, and the sheet says so in words.
      rank: t.rank === "not-stated" ? "ranking not stated" : t.rank,
      provider: t.provider,
      security: t.security,
      factId: fact?.id ?? null,
      display: fact ? displayFor(fact) : BLANK,
      value: fact && typeof fact.value === "number" ? fact.value : null,
      unit: fact?.unit ?? null,
      rung: fact?.rung ?? null,
      isFulcrum: t.isFulcrum,
    };
  });

  // Ladder summary.
  const counts: Record<Rung, number> = { R1: 0, R2: 0, R3: 0, R4: 0 };
  for (const fact of Object.values(f)) counts[fact.rung]++;
  const ladder: LadderSummary = {
    counts,
    total: Object.values(f).length,
  };

  // Verification summary (unique checks).
  const seen = new Set<string>();
  const checks: VerificationCheck[] = [];
  for (const fact of Object.values(f)) {
    for (const c of fact.verification.checks) {
      if (!seen.has(c.id)) {
        seen.add(c.id);
        checks.push(c);
      }
    }
  }
  const verification: VerificationSummary = {
    checks,
    passed: checks.filter((c) => c.passed).length,
    failed: checks.filter((c) => !c.passed).length,
  };

  const narrative = buildNarrative(manifest);

  const references = buildReferences(f);
  const exportRows = buildExportRows(f, evidence);
  const exportFilename = `${slugify(manifest.entity.companyName)}-fact-manifest.csv`;

  return {
    entity: manifest.entity,
    thesis: fixture.thesis,
    primaryPeriod: primary.label,
    narrative,
    tiles,
    financials,
    capital,
    facilities: manifest.capitalStructure ?? null,
    evidence,
    ladder,
    verification,
    references,
    exportRows,
    exportFilename,
    sourceCount: Object.keys(manifest.sources).length,
  };
}

function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "tear-sheet";
}
