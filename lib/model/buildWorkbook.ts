// lib/model/buildWorkbook.ts
// Builds a real .xlsx credit / leverage model from an assembled TearSheet. The point
// of difference versus the CSV export: the derived metrics land as LIVE EXCEL FORMULAS
// over the reported inputs, so flexing an Input cell recomputes EBITDA, net debt,
// leverage and interest cover in the workbook itself. Nothing is invented: a cell only
// carries a number when it traces to a reported fact, and a derived formula is only
// written when every input it needs is present. Abstained lines are left blank.
//
// WP-BE07 added, for live runs:
//   - every figure carries its source reference (document, page, line as printed), on the
//     Inputs sheet beside the figure and on the Sources sheet for every figure the run holds;
//   - a Facilities sheet, the debt note's table from WP-BE16 with its page references;
//   - each formula carries its computed result and the workbook asks for a full recalculation
//     on open, so a viewer that does not calculate still shows the right number, and Excel and
//     LibreOffice recompute from the inputs;
//   - colours and fonts from lib/model/tokens.ts only (Georgia for words, Courier New for figures).

import ExcelJS from "exceljs";
import type { TearSheet, ExportRow } from "../engine/assemble";
import type { EvidenceCard, FacilityCell, FacilityCellKey, CapitalStructure } from "../engine/types";
import { MODEL_TOKENS as T } from "./tokens";
import { BLANK } from "../format/format";

const CUR_FMT = "#,##0;(#,##0)";
const RATIO_FMT = '0.00"x"';
const PCT_FMT = "+0.0%;(0.0%);0.0%";

// What the route knows about the download that the sheet does not: the key it was saved under
// and, when it was asked for by run id, the run. Printed on the Cover so a file on a desktop
// can be traced back to the run that made it.
export interface ModelMeta {
  sheetKey?: string;
  runId?: string;
}

// The reported base lines the model stands on, in display order. Each occupies a fixed
// Inputs row so the Model sheet can reference it by a stable cross-sheet address.
const BASE_LINES: { metric: string; label: string }[] = [
  { metric: "turnover", label: "Turnover" },
  { metric: "operatingProfit", label: "Operating profit (EBIT)" },
  { metric: "depreciationAmortisation", label: "Depreciation & amortisation" },
  { metric: "cash", label: "Cash at bank and in hand" },
  { metric: "borrowings", label: "Total borrowings" },
  { metric: "leaseLiabilitiesTotal", label: "Lease liabilities (total)" },
  { metric: "netInterest", label: "Interest expense" },
];
// Inputs data rows start at row 2 (row 1 is the header). Row of base metric i = 2 + i.
export const INPUT_ROW: Record<string, number> = Object.fromEntries(
  BASE_LINES.map((b, i) => [b.metric, 2 + i])
);

// Model sheet rows, fixed so leverage and interest cover can reference EBITDA and net debt.
// The sheet leads with net debt including leases (Cam, 24 Sep 2026; WP-BE23).
export const MODEL_ROW = { ebitda: 2, netDebtIncl: 3, netDebt: 4, leverage: 5, icover: 6 } as const;

// --- Styling helpers ----------------------------------------------------------
// Every written cell gets an explicit font, so nothing in the workbook falls back to the
// application default (Calibri in Excel).

type FontOpts = { bold?: boolean; italic?: boolean; colour?: string; size?: number };

function textFont(o: FontOpts = {}): Partial<ExcelJS.Font> {
  return {
    name: T.font.text,
    size: o.size ?? T.size.body,
    bold: o.bold ?? false,
    italic: o.italic ?? false,
    color: { argb: o.colour ?? T.colour.ink },
  };
}

function figureFont(o: FontOpts = {}): Partial<ExcelJS.Font> {
  return {
    name: T.font.figure,
    size: o.size ?? T.size.body,
    bold: o.bold ?? false,
    italic: o.italic ?? false,
    color: { argb: o.colour ?? T.colour.ink },
  };
}

function setText(cell: ExcelJS.Cell, value: string, o: FontOpts = {}): void {
  cell.value = value;
  cell.font = textFont(o);
}

function setFigure(cell: ExcelJS.Cell, value: number, numFmt: string, o: FontOpts = {}): void {
  cell.value = value;
  cell.numFmt = numFmt;
  cell.font = figureFont(o);
  cell.alignment = { horizontal: "right" };
}

function setFormula(cell: ExcelJS.Cell, formula: string, result: number | string | undefined, numFmt: string): void {
  // The cached result is what a non-calculating viewer shows; Excel and LibreOffice recompute it
  // on open because the workbook sets fullCalcOnLoad.
  cell.value = result === undefined ? { formula } : ({ formula, result } as ExcelJS.CellFormulaValue);
  cell.numFmt = numFmt;
  cell.font = figureFont();
  cell.alignment = { horizontal: "right" };
}

function styleHeaderCell(cell: ExcelJS.Cell): void {
  cell.font = textFont({ bold: true, size: 10 });
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: T.colour.headerFill } };
  cell.border = { bottom: { style: "thin", color: { argb: T.colour.ink } } };
}

function header(ws: ExcelJS.Worksheet, heads: string[], rightAligned: number[] = []): void {
  heads.forEach((h, i) => {
    const cell = ws.getCell(1, i + 1);
    cell.value = h;
    styleHeaderCell(cell);
    if (rightAligned.includes(i + 1)) cell.alignment = { horizontal: "right" };
  });
}

function hairlineBottom(cell: ExcelJS.Cell): void {
  cell.border = { bottom: { style: "hair", color: { argb: T.colour.hairline } } };
}

// Columns carry the text font too, so a blank cell inside the used range is Georgia when typed in.
function columns(ws: ExcelJS.Worksheet, widths: number[]): void {
  widths.forEach((w, i) => {
    const col = ws.getColumn(i + 1);
    col.width = w;
    col.font = textFont();
  });
}

// --- Source references ----------------------------------------------------------

// A numeric value for metric+period, ONLY when it traces to a reported fact. Returns
// null for an absent line or an R4 abstain (value === "") so callers can leave a blank.
function numericFor(row: ExportRow | undefined): number | null {
  if (!row) return null;
  if (row.value === "" || row.value == null) return null;
  const n = Number(row.value);
  return Number.isFinite(n) ? n : null;
}

export interface SourceRef {
  document: string;
  page: number | null; // 1-based PDF page, when the source names one
  line: string; // the line as printed (the snippet), or the formula for a derived figure
  locator: string;
  printed: string; // the figure exactly as printed, when a scan read recorded it
  contentHash: string;
}

const PAGE_IN_LOCATOR = /\b(?:p\.?|pp\.?|page)\s*(\d{1,4})\b/i;

// The source reference of one figure, from its evidence card. The page comes from the scan read
// when there is one, else from a "p. N" in the locator, else it is not stated. Nothing is guessed.
export function sourceRefFor(card: EvidenceCard | undefined, row: ExportRow): SourceRef {
  const p = card?.provenance ?? null;
  const locator = p?.locator ?? row.sourceLocator ?? "";
  const pageFromLocator = locator.match(PAGE_IN_LOCATOR);
  const page = p?.page ?? (pageFromLocator ? Number(pageFromLocator[1]) : null);
  const line = p?.snippet?.trim() || (card?.derivation ? `derived: ${card.derivation.formula}` : "");
  return {
    document: p?.documentName ?? row.sourceDocument ?? "",
    page: Number.isInteger(page) ? page : null,
    line: line.length > 240 ? `${line.slice(0, 237)}...` : line,
    locator,
    printed: p?.printedText ?? "",
    contentHash: row.contentHash,
  };
}

// --- The workbook ----------------------------------------------------------------

// Assemble the workbook synchronously (every cell / formula is written here). Kept
// separate from the async buffer write so tests can assert directly on the Workbook
// object (cells, formulas, blanks) without a serialise round-trip.
export function assembleModelWorkbook(sheet: TearSheet, meta: ModelMeta = {}): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Origination model engine";
  wb.created = new Date();
  // Excel and LibreOffice recompute every formula when the file opens.
  wb.calcProperties.fullCalcOnLoad = true;

  // Index every fact by `${metric}.${period}` for O(1) lookup of base lines.
  const byKey = new Map<string, ExportRow>();
  for (const r of sheet.exportRows) byKey.set(`${r.metric}.${r.period}`, r);

  const latest = sheet.financials.latestLabel;
  const prior = sheet.financials.priorLabel; // null when only one period on file

  const get = (metric: string, period: string | null) =>
    period === null ? null : numericFor(byKey.get(`${metric}.${period}`));
  const refFor = (row: ExportRow) => sourceRefFor(sheet.evidence[`${row.metric}.${row.period}`], row);
  // A lease line on the sheet at all, read or abstained: the source asked for leases (WP-BE23).
  const leasesOnSheet = (period: string | null) =>
    period !== null &&
    ["leaseLiabilitiesTotal", "leaseLiabilitiesCurrent", "leaseLiabilitiesNonCurrent"].some((m) => byKey.has(`${m}.${period}`));

  buildCover(wb, sheet, latest, prior, meta);
  buildInputs(wb, byKey, latest, prior, refFor);
  buildModel(wb, latest, prior, get, leasesOnSheet);
  buildCapital(wb, sheet);
  buildFacilities(wb, sheet.facilities);
  buildSources(wb, sheet, latest, prior, refFor);
  buildProvenance(wb, sheet);

  return wb;
}

// Serialise the assembled workbook to an .xlsx buffer for the route handler.
export async function buildModelWorkbook(sheet: TearSheet, meta: ModelMeta = {}): Promise<ExcelJS.Buffer> {
  return assembleModelWorkbook(sheet, meta).xlsx.writeBuffer();
}

// Which record the sheet came from, from its key prefix (lib/workspace.ts sourceKey).
function modeLine(sheet: TearSheet, key: string | undefined): string {
  if (sheet.entity.synthetic) return "Illustrative, synthetic data";
  if (key?.startsWith("ch-")) return "Live, Companies House public record";
  if (key?.startsWith("esef-")) return "Live, ESEF annual financial report (filings.xbrl.org)";
  if (key?.startsWith("sec-")) return "Live, SEC EDGAR company facts";
  return "Live, public record";
}

// --- Cover -------------------------------------------------------------------
function buildCover(
  wb: ExcelJS.Workbook,
  sheet: TearSheet,
  latest: string,
  prior: string | null,
  meta: ModelMeta
): void {
  const ws = wb.addWorksheet("Cover");
  columns(ws, [26, 70]);

  const periods = prior ? `${latest} (prior ${prior})` : latest;

  setText(ws.getCell("A1"), sheet.entity.companyName, { bold: true, size: T.size.title });
  ws.mergeCells("A1:B1");

  const rows: [string, string][] = [
    ["Credit / leverage model", ""],
    ["Company number", sheet.entity.companyNumber],
    ["Jurisdiction", sheet.entity.jurisdiction],
    ["Status", sheet.entity.status],
    ["Accounts type", sheet.entity.accountsType],
    ["Period(s)", periods],
    ["Mode", modeLine(sheet, meta.sheetKey)],
    ["Sheet key", meta.sheetKey ?? "not recorded"],
    ["Run id", meta.runId ?? "not asked for by run"],
    ["Generated", new Date().toISOString().slice(0, 10)],
  ];
  let r = 3;
  for (const [k, v] of rows) {
    setText(ws.getCell(`A${r}`), k, { bold: true, colour: T.colour.muted });
    setText(ws.getCell(`B${r}`), v, k === "Mode" ? { bold: true, colour: T.colour.accent } : {});
    r++;
  }

  r++;
  setText(
    ws.getCell(`A${r}`),
    "Derived cells (EBITDA, net debt including and excluding leases, leverage, interest cover) are live formulas over the Inputs sheet. Leverage divides net debt including leases by EBITDA, which is before lease costs. Every figure names its document, page and printed line on the Inputs and Sources sheets. Abstained or unreported lines are left blank rather than invented.",
    { italic: true, colour: T.colour.muted, size: T.size.caption }
  );
  ws.getCell(`A${r}`).alignment = { wrapText: true, vertical: "top" };
  ws.mergeCells(`A${r}:B${r}`);
  ws.getRow(r).height = 44;
}

// --- Inputs ------------------------------------------------------------------
// The reported base lines. Latest is ALWAYS column B and prior ALWAYS column C (blank when
// there is no prior period), so the Model sheet's cross-sheet formulas have stable addresses.
// Only reported facts get a number; an absent or abstained line is left blank and says so.
export const INPUT_COLS = {
  label: 1,
  latest: 2,
  prior: 3,
  unit: 4,
  rung: 5,
  document: 6,
  page: 7,
  line: 8,
  priorSource: 9,
} as const;

function sourceText(ref: SourceRef): string {
  return [ref.document, ref.page !== null ? `p. ${ref.page}` : "page not stated", ref.line || ref.locator]
    .filter(Boolean)
    .join(", ");
}

function buildInputs(
  wb: ExcelJS.Workbook,
  byKey: Map<string, ExportRow>,
  latest: string,
  prior: string | null,
  refFor: (row: ExportRow) => SourceRef
): void {
  const ws = wb.addWorksheet("Inputs");
  const C = INPUT_COLS;
  columns(ws, [32, 16, 16, 8, 14, 40, 8, 48, 48]);
  header(
    ws,
    ["Reported line", latest, prior ?? "No prior period", "Unit", "Rung", "Document", "Page", "Line as printed", "Prior period source"],
    [C.latest, C.prior, C.page]
  );

  for (const base of BASE_LINES) {
    const row = INPUT_ROW[base.metric];
    setText(ws.getCell(row, C.label), base.label);

    const latestRow = byKey.get(`${base.metric}.${latest}`);
    const latestVal = numericFor(latestRow);
    if (latestVal !== null) setFigure(ws.getCell(row, C.latest), latestVal, CUR_FMT, { colour: T.colour.input });

    const priorRow = prior ? byKey.get(`${base.metric}.${prior}`) : undefined;
    const priorVal = numericFor(priorRow);
    if (priorVal !== null) setFigure(ws.getCell(row, C.prior), priorVal, CUR_FMT, { colour: T.colour.input });

    // Unit, rung and source describe the latest period's fact. The fact's own unit: a USD
    // filer's inputs were labelled GBP here (WP-QA03 N4).
    setText(ws.getCell(row, C.unit), latestRow?.unit || "");
    ws.getCell(row, C.unit).alignment = { horizontal: "center" };
    const reported = latestVal !== null && !!latestRow;
    if (reported) {
      const ref = refFor(latestRow!);
      setText(ws.getCell(row, C.rung), latestRow!.rung);
      setText(ws.getCell(row, C.document), ref.document);
      if (ref.page !== null) setFigure(ws.getCell(row, C.page), ref.page, "0");
      else setText(ws.getCell(row, C.page), "not stated", { italic: true, colour: T.colour.muted });
      setText(ws.getCell(row, C.line), ref.line || ref.locator);
    } else {
      const quiet = { italic: true, colour: T.colour.muted };
      setText(ws.getCell(row, C.rung), "R4 / not reported", quiet);
      setText(ws.getCell(row, C.document), "not reported", quiet);
    }
    if (priorVal !== null && priorRow) setText(ws.getCell(row, C.priorSource), sourceText(refFor(priorRow)));
    for (let c = 1; c <= C.priorSource; c++) {
      hairlineBottom(ws.getCell(row, c));
      if (c >= C.document) ws.getCell(row, c).alignment = { vertical: "top", wrapText: c !== C.page };
    }
  }
}

// --- Model -------------------------------------------------------------------
// The derived metrics, written as LIVE cross-sheet formulas over the Inputs. A formula
// is only written when every input it consumes is present, so the model can never show
// a fabricated derived number: a missing input leaves the derived cell blank.
function buildModel(
  wb: ExcelJS.Workbook,
  latest: string,
  prior: string | null,
  get: (metric: string, period: string | null) => number | null,
  leasesOnSheet: (period: string | null) => boolean
): void {
  const ws = wb.addWorksheet("Model");
  const hasPrior = !!prior;
  columns(ws, hasPrior ? [44, 16, 16, 12] : [44, 16]);
  header(ws, hasPrior ? ["Derived metric", latest, prior as string, "YoY"] : ["Derived metric", latest], [2, 3, 4]);

  // Cross-sheet address for a base metric in a given column (B latest, C prior).
  const inp = (metric: string, col: "B" | "C") => `Inputs!${col}${INPUT_ROW[metric]}`;
  const R = MODEL_ROW;

  // Leverage pairs like with like, as the ladder does (lib/engine/ladder.ts leverageResolver,
  // WP-BE23). EBITDA is operating profit plus all D&A, so where leases are on the balance sheet it
  // is before lease costs and is divided into net debt INCLUDING leases. A sheet that asked for
  // leases and has no lease total leaves leverage blank. A sheet from a source that reads no lease
  // line divides net debt excluding leases, and the label says so.
  type Basis = "incl" | "excl" | null;
  // The values the formulas will compute, worked out here only to cache them as results. Null
  // means the formula is not written at all.
  const values = (p: string | null) => {
    const op = get("operatingProfit", p);
    const da = get("depreciationAmortisation", p);
    const cash = get("cash", p);
    const debt = get("borrowings", p);
    const leases = get("leaseLiabilitiesTotal", p);
    const interest = get("netInterest", p);
    const ebitda = op !== null && da !== null ? op + da : null;
    const netDebt = debt !== null && cash !== null ? debt - cash : null;
    const netDebtIncl = debt !== null && leases !== null && cash !== null ? debt + leases - cash : null;
    const basis: Basis = ebitda === null ? null : netDebtIncl !== null ? "incl" : leasesOnSheet(p) ? null : netDebt !== null ? "excl" : null;
    const paired = basis === "incl" ? netDebtIncl : basis === "excl" ? netDebt : null;
    const leverage: number | string | null =
      ebitda !== null && paired !== null ? (ebitda <= 0 ? "" : paired / ebitda) : null;
    const icover: number | string | null =
      ebitda !== null && interest !== null ? (interest === 0 ? "" : ebitda / interest) : null;
    return { ebitda, netDebtIncl, netDebt, leverage, icover, basis };
  };
  const vLatest = values(latest);
  const vPrior = hasPrior ? values(prior) : null;

  type Key = Exclude<keyof ReturnType<typeof values>, "basis">;
  const writeRow = (rowNum: number, label: string, numFmt: string, key: Key, formula: (col: "B" | "C") => string) => {
    setText(ws.getCell(rowNum, 1), label);
    const b = vLatest[key];
    if (b !== null) setFormula(ws.getCell(rowNum, 2), formula("B"), b, numFmt);
    if (vPrior) {
      const c = vPrior[key];
      if (c !== null) setFormula(ws.getCell(rowNum, 3), formula("C"), c, numFmt);
      if (b !== null && c !== null) {
        // YoY as a live formula over the two derived cells, guarded against /0.
        const result = typeof b === "number" && typeof c === "number" ? (c === 0 ? "" : (b - c) / Math.abs(c)) : "";
        setFormula(ws.getCell(rowNum, 4), `IF(C${rowNum}=0,"",(B${rowNum}-C${rowNum})/ABS(C${rowNum}))`, result, PCT_FMT);
      }
    }
    for (let c = 1; c <= (hasPrior ? 4 : 2); c++) hairlineBottom(ws.getCell(rowNum, c));
  };

  // EBITDA = EBIT + D&A.
  writeRow(R.ebitda, "EBITDA", CUR_FMT, "ebitda", (col) => `${inp("operatingProfit", col)}+${inp("depreciationAmortisation", col)}`);
  // Net debt including leases = Total borrowings + Lease liabilities (total) - Cash.
  writeRow(R.netDebtIncl, "Net debt including leases", CUR_FMT, "netDebtIncl", (col) =>
    `${inp("borrowings", col)}+${inp("leaseLiabilitiesTotal", col)}-${inp("cash", col)}`
  );
  // Net debt excluding leases = Total borrowings - Cash.
  writeRow(R.netDebt, "Net debt excluding leases", CUR_FMT, "netDebt", (col) => `${inp("borrowings", col)}-${inp("cash", col)}`);
  // Leverage = the paired net debt / EBITDA (references this sheet's own derived cells).
  writeRow(
    R.leverage,
    vLatest.basis === "excl"
      ? "Leverage (net debt excluding leases / EBITDA; no lease line on this sheet)"
      : "Leverage (net debt including leases / EBITDA)",
    RATIO_FMT,
    "leverage",
    (col) => {
      const nd = (col === "B" ? vLatest : vPrior)?.basis === "incl" ? R.netDebtIncl : R.netDebt;
      return `IF(${col}${R.ebitda}<=0,"",${col}${nd}/${col}${R.ebitda})`;
    }
  );
  // Interest cover = EBITDA / Interest expense (gross; interest income is not netted off).
  writeRow(R.icover, "Interest cover (EBITDA / interest expense)", RATIO_FMT, "icover", (col) =>
    `IF(${inp("netInterest", col)}=0,"",${col}${R.ebitda}/${inp("netInterest", col)})`
  );

  const foot = 8;
  setText(
    ws.getCell(foot, 1),
    "Cells above are live formulas over the Inputs sheet. Edit an Input and these recompute. A blank means a required input was not reported.",
    { italic: true, colour: T.colour.muted, size: T.size.caption }
  );
  ws.getCell(foot, 1).alignment = { wrapText: true, vertical: "top" };
  ws.mergeCells(foot, 1, foot, hasPrior ? 4 : 2);
  ws.getRow(foot).height = 30;
}

// --- Capital structure -------------------------------------------------------
// The tranches the sheet shows. On a live sheet these are registered charges, which state
// security and never ranking, so no row is marked as a fulcrum unless the sheet itself says so.
function buildCapital(wb: ExcelJS.Workbook, sheet: TearSheet): void {
  const ws = wb.addWorksheet("Capital structure");
  columns(ws, [36, 20, 40, 16, 16]);
  header(ws, ["Tranche / holder", "Rank", "Security", "Status / rung", "Amount"], [5]);

  let row = 2;
  for (const t of sheet.capital) {
    setText(ws.getCell(row, 1), `${t.name} - ${t.provider}`);
    setText(ws.getCell(row, 2), t.rank);
    setText(ws.getCell(row, 3), t.security);
    setText(ws.getCell(row, 4), t.rung ?? "not reported");
    // Amount only when the tranche has a resolved fact, and then the fact's own value. The
    // display is rounded ("£22.4m" for 22,437,500), so it is never parsed back (WP-QA03 N6).
    if (t.value !== null) setFigure(ws.getCell(row, 5), t.value, CUR_FMT);
    else setText(ws.getCell(row, 5), t.display === BLANK ? "" : t.display);
    ws.getCell(row, 5).alignment = { horizontal: "right" };
    const rule = t.isFulcrum ? { style: "thin" as const, color: { argb: T.colour.accent } } : { style: "hair" as const, color: { argb: T.colour.hairline } };
    for (let c = 1; c <= 5; c++) ws.getCell(row, c).border = { bottom: rule };
    row++;
  }
  if (sheet.capital.length === 0) {
    setText(ws.getCell(2, 1), "No tranche is on the record for this sheet.", { italic: true, colour: T.colour.muted });
  }
}

// --- Facilities (WP-BE16's debt-note table) -----------------------------------
// One row per facility the note prints, in the note's order. A cell holds what two reads agreed
// on, "not printed", or the abstention and its reason. An agreed amount is a number in pounds with
// the printed scale applied; an amount printed as words ("undrawn", "nil") stays words.

const FACILITY_HEADS: { key: FacilityCellKey; label: string }[] = [
  { key: "drawn", label: "Drawn" },
  { key: "committed", label: "Committed" },
  { key: "maturity", label: "Maturity" },
  { key: "rateOrMargin", label: "Rate or margin" },
  { key: "security", label: "Security" },
  { key: "lender", label: "Lender" },
  { key: "ranking", label: "Ranking (the note's words)" },
];
export const FACILITY_TABLE_HEADER = ["Facility", "Type", ...FACILITY_HEADS.map((h) => h.label), "Page", "Citation"];

function writeFacilityCell(cell: ExcelJS.Cell, f: FacilityCell, isAmount: boolean): void {
  if (f.status === "agreed") {
    if (isAmount && f.pounds !== null && !f.nil) setFigure(cell, f.pounds, CUR_FMT);
    else setText(cell, f.text ?? "");
  } else if (f.status === "not-printed") {
    setText(cell, "not printed", { italic: true, colour: T.colour.muted });
  } else {
    setText(cell, `abstains: ${f.reason ?? "no reason recorded"}`, { italic: true, colour: T.colour.muted });
  }
  cell.alignment = { vertical: "top", wrapText: true, horizontal: isAmount && f.status === "agreed" && f.pounds !== null && !f.nil ? "right" : "left" };
}

function buildFacilities(wb: ExcelJS.Workbook, table: CapitalStructure | null): void {
  const ws = wb.addWorksheet("Facilities");
  columns(ws, [30, 18, 16, 16, 16, 20, 26, 20, 24, 8, 48]);
  const quiet = { italic: true, colour: T.colour.muted };

  if (!table) {
    setText(ws.getCell(1, 1), "Facilities from the debt note", { bold: true, colour: T.colour.accent });
    setText(ws.getCell(2, 1), "No scanned debt note was read for this sheet, so there is no facilities table. Registered charges, if any, are on the Capital structure sheet.", quiet);
    return;
  }

  const meta: [string, string][] = [
    ["Status", table.status === "found" ? "found" : `abstains: ${table.reason ?? "no reason recorded"}`],
    ["Note", table.noteHeading ?? "not printed"],
    ["Pages read", table.pages.length ? table.pages.join(", ") : "none"],
    ["Scale as printed", table.scaleCaption ?? "not printed"],
    ["Whose table", table.basis?.text ?? "not labelled"],
    ["Read by", `${table.verifier}, filing ${table.transactionId}`],
    ["Ranking", "No fulcrum and no seniority order is stated. The ranking column holds only the note's own words."],
  ];
  setText(ws.getCell(1, 1), "Facilities from the debt note", { bold: true, colour: T.colour.accent });
  let r = 2;
  for (const [k, v] of meta) {
    setText(ws.getCell(r, 1), k, { bold: true, colour: T.colour.muted });
    setText(ws.getCell(r, 2), v);
    ws.mergeCells(r, 2, r, FACILITY_TABLE_HEADER.length);
    r++;
  }
  r++;

  const headRow = r;
  FACILITY_TABLE_HEADER.forEach((h, i) => {
    const cell = ws.getCell(headRow, i + 1);
    cell.value = h;
    styleHeaderCell(cell);
  });
  r++;

  for (const row of table.rows) {
    setText(ws.getCell(r, 1), row.name ?? "name not printed");
    setText(ws.getCell(r, 2), row.type ?? "");
    if (row.status === "abstain") {
      setText(ws.getCell(r, 3), `abstains: ${row.reason ?? "no reason recorded"}`, quiet);
    } else {
      FACILITY_HEADS.forEach((h, i) => writeFacilityCell(ws.getCell(r, 3 + i), row.cells[h.key], h.key === "drawn" || h.key === "committed"));
    }
    const pageCol = 3 + FACILITY_HEADS.length;
    if (row.page !== null) setFigure(ws.getCell(r, pageCol), row.page, "0");
    else setText(ws.getCell(r, pageCol), "not stated", quiet);
    setText(ws.getCell(r, pageCol + 1), row.citation);
    ws.getCell(r, pageCol + 1).alignment = { vertical: "top", wrapText: true };
    for (let c = 1; c <= FACILITY_TABLE_HEADER.length; c++) hairlineBottom(ws.getCell(r, c));
    r++;
  }
  if (table.rows.length === 0) {
    setText(ws.getCell(r, 1), "The note lists no facility.", quiet);
    r++;
  }

  if (table.notes.length) {
    r++;
    for (const note of table.notes) {
      setText(ws.getCell(r, 1), note, { ...quiet, size: T.size.caption });
      ws.mergeCells(r, 1, r, FACILITY_TABLE_HEADER.length);
      r++;
    }
  }
}

// --- Sources -------------------------------------------------------------------
// One row per figure the run holds a value for, with its document, page and the line as printed.
// Base lines also name the Inputs cell they feed, so a reader can go from a model figure to the
// filing and back.
export const SOURCES_HEADER = ["Figure", "Period", "Value", "Unit", "Rung", "Document", "Page", "Line as printed", "Printed figure", "Locator", "Input cell", "Content hash"];

// A ratio keeps its decimals, a money figure is shown in whole units, and any other figure with a
// fraction keeps two places, so no format rounds a figure into one the filing did not print.
export function numFmtFor(unit: string, n: number): string {
  if (unit === "x") return RATIO_FMT;
  if (unit === "GBP" || unit === "USD" || unit === "EUR") return Number.isInteger(n) ? CUR_FMT : "#,##0.00;(#,##0.00)";
  return Number.isInteger(n) ? "#,##0" : "#,##0.00";
}

function buildSources(
  wb: ExcelJS.Workbook,
  sheet: TearSheet,
  latest: string,
  prior: string | null,
  refFor: (row: ExportRow) => SourceRef
): void {
  const ws = wb.addWorksheet("Sources");
  columns(ws, [30, 10, 18, 8, 8, 40, 8, 48, 16, 30, 12, 20]);
  header(ws, SOURCES_HEADER, [3, 7]);

  let r = 2;
  for (const row of sheet.exportRows) {
    if (row.value === "" || row.value == null) continue;
    const ref = refFor(row);
    setText(ws.getCell(r, 1), row.label);
    setText(ws.getCell(r, 2), row.period);
    const n = Number(row.value);
    // Only a figure with a unit is a number: a SIC code or a year is text and stays text.
    if (row.unit && Number.isFinite(n) && row.value.trim() !== "") setFigure(ws.getCell(r, 3), n, numFmtFor(row.unit, n));
    else setText(ws.getCell(r, 3), row.value);
    setText(ws.getCell(r, 4), row.unit);
    setText(ws.getCell(r, 5), row.rung);
    setText(ws.getCell(r, 6), ref.document || "not recorded", ref.document ? {} : { italic: true, colour: T.colour.muted });
    if (ref.page !== null) setFigure(ws.getCell(r, 7), ref.page, "0");
    else setText(ws.getCell(r, 7), "not stated", { italic: true, colour: T.colour.muted });
    setText(ws.getCell(r, 8), ref.line);
    setText(ws.getCell(r, 9), ref.printed);
    setText(ws.getCell(r, 10), ref.locator);
    const inputRow = INPUT_ROW[row.metric];
    const inputCol = row.period === latest ? "B" : row.period === prior ? "C" : null;
    setText(ws.getCell(r, 11), inputRow && inputCol ? `Inputs!${inputCol}${inputRow}` : "");
    setText(ws.getCell(r, 12), row.contentHash, { colour: T.colour.muted, size: T.size.caption });
    for (let c = 1; c <= SOURCES_HEADER.length; c++) {
      hairlineBottom(ws.getCell(r, c));
      ws.getCell(r, c).alignment = { ...ws.getCell(r, c).alignment, vertical: "top", wrapText: c === 8 };
    }
    r++;
  }
}

// --- Provenance --------------------------------------------------------------
// The audit trail: one row per distinct cited passage, cross-referenced to the figures
// it backs, with its content hash as at ingest.
function buildProvenance(wb: ExcelJS.Workbook, sheet: TearSheet): void {
  const ws = wb.addWorksheet("Provenance");
  columns(ws, [6, 44, 34, 26, 10, 30]);
  header(ws, ["Ref", "Figures backed", "Document", "Locator", "Rung", "Content hash"]);

  let row = 2;
  for (const ref of sheet.references) {
    setText(ws.getCell(row, 1), `[${ref.citation}]`);
    setText(ws.getCell(row, 2), ref.backs.map((b) => `${b.label} (${b.period})`).join("; "));
    setText(ws.getCell(row, 3), `[${ref.tag}] ${ref.documentName}`);
    setText(ws.getCell(row, 4), ref.locator);
    setText(ws.getCell(row, 5), [...new Set(ref.backs.map((b) => b.rung))].join(", "));
    setText(ws.getCell(row, 6), [...new Set(ref.backs.map((b) => b.contentHash))].join(", "), { colour: T.colour.muted, size: T.size.caption });
    for (let c = 1; c <= 6; c++) {
      hairlineBottom(ws.getCell(row, c));
      ws.getCell(row, c).alignment = { vertical: "top", wrapText: c === 2 };
    }
    row++;
  }
  if (sheet.references.length === 0) {
    setText(
      ws.getCell(2, 1),
      "No external passage is cited: every figure either abstained or was synthesised from inputs on their own cards.",
      { italic: true, colour: T.colour.muted }
    );
    ws.mergeCells(2, 1, 2, 6);
  }
}
