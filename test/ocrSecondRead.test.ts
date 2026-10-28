// test/ocrSecondRead.test.ts (WP-OCR2)
// The second read on local OCR. Every test here reads OCR output from a fixture: hand-built page
// layers below, and one stored layer of a real gold page (eval/gold/uk/ocr/, made by
// eval/gold/uk/ocr-pages.ts). No test runs OCR, and none calls a model.

import { existsSync, mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { suite, test, assert, assertEqual } from "./harness";
import { diskPageSource, memoryPageSource, timeMeasures, type OcrObservation, type OcrPageLayer } from "../lib/ocr/pageLayer";
import { OCR_ABSTAIN, OCR_VERIFIER_NAME, labelScore, ocrSecondRead, rowsOf, segmentsOf } from "../lib/vision/ocrSecondRead";
import { OcrSecondReadVerifier } from "../lib/vision/ocrVerify";
import { applyVerification, createVisionVerifier, doubleReadProblem, secondReadMode, DOUBLE_READ_VERIFIER_NAME } from "../lib/vision/verify";
import { BASE_LINE_KEYS, type BaseLineKey, type FoundLine, type VisionLine, type VisionReadResult } from "../lib/vision/types";

const HERE = dirname(fileURLToPath(import.meta.url));
const PERIOD = "2026-03-31";
const TX = "ocr-test";

// --- Fixtures -----------------------------------------------------------------

const o = (text: string, x0: number, y0: number, x1: number, y1 = y0 + 0.012): OcrObservation => ({ text, confidence: 0.99, box: [x0, y0, x1, y1] });

// A row: a label at the left, a note number, then this year's and last year's figures.
function row(y: number, label: string, current: string | null, prior: string | null, note?: string): OcrObservation[] {
  return [
    o(label, 0.1, y, 0.1 + 0.012 * label.length),
    ...(note ? [o(note, 0.55, y, 0.57)] : []),
    ...(current ? [o(current, 0.75 - 0.012 * current.length, y, 0.75)] : []),
    ...(prior ? [o(prior, 0.89 - 0.012 * prior.length, y, 0.89)] : []),
  ];
}

function balanceSheet(opts: { caption?: boolean; title?: string; cash?: string; equity?: string } = {}): OcrPageLayer {
  const caption = opts.caption ?? true;
  return {
    engine: "fixture",
    page: 10,
    width: 595,
    height: 842,
    observations: [
      o(opts.title ?? "Group balance sheet", 0.1, 0.05, 0.35),
      o("at 31 March 2026", 0.1, 0.07, 0.3),
      o("2026", 0.7, 0.15, 0.75),
      o("2025", 0.84, 0.15, 0.89),
      ...(caption ? [o("£m", 0.72, 0.17, 0.75), o("£m", 0.86, 0.17, 0.89)] : []),
      o("Current assets", 0.1, 0.21, 0.28),
      ...row(0.23, "Other receivables", "26.6", "26.6", "9"),
      ...row(0.25, "Cash and cash equivalents", opts.cash ?? "1.7", "0.3", "12"),
      ...row(0.3, "Net assets", "25.1", "20.0"),
      ...row(0.35, "Total equity", opts.equity ?? "25.1", "20.0"),
    ],
  };
}

function found(key: BaseLineKey, figureText: string, printedLabel: string, page = 10, scaleCaption = "£m"): FoundLine {
  const negative = figureText.startsWith("(");
  const magnitude = Number(figureText.replace(/[(),]/g, ""));
  void key;
  return {
    status: "found",
    printedLabel,
    figureText,
    value: negative ? -magnitude : magnitude,
    sign: negative ? "negative" : "positive",
    scaleCaption,
    pdfPageIndex: page,
    printedPageNumber: null,
    statement: "Group balance sheet",
    periodEnd: PERIOD,
    noteReference: null,
  };
}

function firstRead(lines: Partial<Record<BaseLineKey, FoundLine>>, periodEnd = PERIOD, basis: VisionReadResult["document"]["basis"] = "consolidated"): VisionReadResult {
  return {
    outcome: "read",
    fromCache: false,
    cacheKey: "test",
    schemaVersion: 1,
    promptVersion: "p2",
    model: "claude-opus-5",
    transactionId: TX,
    companyNumber: "00000001",
    pageSet: "all",
    document: { companyNameAsPrinted: "Test Group plc", periodEnd, currency: "GBP", basis },
    lines: Object.fromEntries(BASE_LINE_KEYS.map((k) => [k, lines[k] ?? { status: "abstain", reason: "not-printed" }])) as Record<BaseLineKey, VisionLine>,
    debtNote: { status: "abstain", reason: "not-read" },
    usage: null,
    recordedUsage: null,
  };
}

async function verify(read: VisionReadResult, layers: Record<number, OcrPageLayer>, accountsType: "group" | null = null) {
  const pages = memoryPageSource(Object.fromEntries(Object.entries(layers).map(([p, l]) => [`${TX}:${p}`, l])));
  return new OcrSecondReadVerifier({ pages }).verify({ read, pdfBytes: new Uint8Array(), pageCount: 20, accountsType });
}

// --- Tests --------------------------------------------------------------------

suite("OCR second read (WP-OCR2)");

test("a figure OCR reads on the cited line, in the period column, under a printed caption, is confirmed", async () => {
  const read = firstRead({ cash_at_bank: found("cash_at_bank", "1.7", "Cash and cash equivalents") });
  const r = await verify(read, { 10: balanceSheet() });
  assertEqual(r.verifier, OCR_VERIFIER_NAME, "verifier name");
  assertEqual(r.usage, null, "no model call, no usage");
  assertEqual(r.lines.cash_at_bank.tag, "verified", "confirmed");
  const e = r.lines.cash_at_bank.evidence!;
  assertEqual(e.second.figureText, "1.7", "OCR's own reading is on the record");
  assertEqual(e.second.headerScaleCaption, "£m", "caption");
  assertEqual(e.second.columnHeading, "2026", "column");
  assertEqual(e.pounds, 1_700_000, "pounds");
  // The landing rule accepts what the OCR verifier records.
  assertEqual(doubleReadProblem(read.lines.cash_at_bank as FoundLine, r.lines.cash_at_bank), null, "lands");
});

test("a first read that took the comparative column is not confirmed: OCR reads this year's column", async () => {
  const read = firstRead({ cash_at_bank: found("cash_at_bank", "0.3", "Cash and cash equivalents") });
  const r = await verify(read, { 10: balanceSheet() });
  assertEqual(r.lines.cash_at_bank.tag, "rejected", "rejected");
  assert(/disagreed/.test(r.overrides.cash_at_bank!.reason), r.overrides.cash_at_bank!.reason);
  assertEqual(r.diagnostics[0].ocr, "1.7", "OCR read the current column");
});

test("same digits with a different sign disagree", async () => {
  const read = firstRead({ cash_at_bank: found("cash_at_bank", "(1.7)", "Cash and cash equivalents") });
  const r = await verify(read, { 10: balanceSheet() });
  assertEqual(r.lines.cash_at_bank.tag, "rejected", "rejected");
  assert(/disagreed/.test(r.overrides.cash_at_bank!.reason), r.overrides.cash_at_bank!.reason);
});

test("same digits under a different scale are not confirmed", async () => {
  const read = firstRead({ cash_at_bank: found("cash_at_bank", "1.7", "Cash and cash equivalents", 10, "£'000") });
  const r = await verify(read, { 10: balanceSheet() });
  assertEqual(r.lines.cash_at_bank.tag, "rejected", "rejected");
});

test("no unit caption read on the page: the digits agree but the line abstains", async () => {
  const read = firstRead({ cash_at_bank: found("cash_at_bank", "1.7", "Cash and cash equivalents") });
  const r = await verify(read, { 10: balanceSheet({ caption: false }) });
  assertEqual(r.lines.cash_at_bank.tag, "rejected", "rejected");
  assert(/scale could not be established/.test(r.overrides.cash_at_bank!.reason), r.overrides.cash_at_bank!.reason);
  assertEqual(r.diagnostics[0].ocr, "1.7", "OCR did read the figure");
});

test("an 'Em' caption is not taken for '£m': OCR's E could be a euro sign", async () => {
  const layer = balanceSheet({ caption: false });
  layer.observations.push(o("Em", 0.72, 0.17, 0.75), o("Em", 0.86, 0.17, 0.89));
  const r = await verify(firstRead({ cash_at_bank: found("cash_at_bank", "1.7", "Cash and cash equivalents") }), { 10: layer });
  assertEqual(r.lines.cash_at_bank.tag, "rejected", "rejected");
});

test("no OCR layer for the cited page abstains with a named reason", async () => {
  const r = await verify(firstRead({ cash_at_bank: found("cash_at_bank", "1.7", "Cash and cash equivalents") }), {});
  assertEqual(r.lines.cash_at_bank.tag, "rejected", "rejected");
  assertEqual(r.diagnostics[0].code, OCR_ABSTAIN.noLayer, "code");
  assert(r.overrides.cash_at_bank!.reason.includes(OCR_ABSTAIN.noLayer), r.overrides.cash_at_bank!.reason);
});

test("a label the first read put under the wrong key is found but does not name the key", async () => {
  const read = firstRead({ cash_at_bank: found("cash_at_bank", "26.6", "Other receivables") });
  const r = await verify(read, { 10: balanceSheet() });
  assertEqual(r.lines.cash_at_bank.tag, "rejected", "rejected");
  assertEqual(r.diagnostics[0].code, OCR_ABSTAIN.labelNotKey, "code");
});

test("a label that is not on the page abstains", async () => {
  const r = await verify(firstRead({ turnover: found("turnover", "10.0", "Revenue") }), { 10: balanceSheet() });
  assertEqual(r.diagnostics[0].code, OCR_ABSTAIN.noLabel, "code");
});

test("a garbled cell is unreadable, never a disagreement", async () => {
  const r = await verify(firstRead({ cash_at_bank: found("cash_at_bank", "1.7", "Cash and cash equivalents") }), { 10: balanceSheet({ cash: "1.7€ł" }) });
  assertEqual(r.lines.cash_at_bank.tag, "rejected", "rejected");
  assert(r.diagnostics[0].code === OCR_ABSTAIN.unreadable || r.diagnostics[0].code === OCR_ABSTAIN.emptyCell, String(r.diagnostics[0].code));
});

test("a printed tie that fails abstains figures OCR agreed", async () => {
  const read = firstRead({ net_assets: found("net_assets", "25.1", "Net assets") });
  const ok = await verify(read, { 10: balanceSheet() });
  assertEqual(ok.lines.net_assets.tag, "verified", "ties with total equity 25.1");
  assert(ok.lines.net_assets.evidence!.ties.some((t) => t.status === "pass"), "the tie ran and passed");
  const bad = await verify(read, { 10: balanceSheet({ equity: "24.0" }) });
  assertEqual(bad.lines.net_assets.tag, "rejected", "tie fails");
  assert(/do not add up/.test(bad.overrides.net_assets!.reason), bad.overrides.net_assets!.reason);
});

test("group accounts: a page headed 'Company balance sheet' abstains on basis", async () => {
  const read = firstRead({ cash_at_bank: found("cash_at_bank", "1.7", "Cash and cash equivalents") });
  const r = await verify(read, { 10: balanceSheet({ title: "Company balance sheet" }) }, "group");
  assertEqual(r.lines.cash_at_bank.tag, "rejected", "rejected");
  const g = await verify(read, { 10: balanceSheet() }, "group");
  assertEqual(g.lines.cash_at_bank.tag, "verified", "group heading confirms");
});

function spanning(subs: string[]): OcrPageLayer {
  const xs = [0.4, 0.5, 0.6];
  return {
    engine: "fixture",
    page: 5,
    width: 595,
    height: 842,
    observations: [
      o("INCOME STATEMENT", 0.1, 0.05, 0.3),
      o("2026", 0.49, 0.15, 0.53),
      o("2025", 0.77, 0.15, 0.81),
      ...subs.map((s, i) => o(s, xs[i], 0.17, xs[i] + 0.06)),
      o("£m", 0.44, 0.19, 0.46),
      o("£m", 0.54, 0.19, 0.56),
      o("£m", 0.63, 0.19, 0.66),
      o("Operating profit", 0.1, 0.25, 0.3),
      o("268.1", 0.42, 0.25, 0.46),
      o("(10.4)", 0.52, 0.25, 0.56),
      o("257.7", 0.62, 0.25, 0.66),
      o("323.6", 0.85, 0.25, 0.89),
    ],
  };
}

// The page is Travelodge Hotels' p29, a single company: its recorded first read
// (fixtures/vision/verify/00769170-first.json) gives basis "company", and the register says "full".
// firstRead's default basis, "consolidated", would make it a group filer printing no group heading.
test("under a heading spanning Underlying | Non-underlying | Total, OCR reads the Total column", async () => {
  const read = firstRead({ operating_profit: { ...found("operating_profit", "257.7", "Operating profit", 5), statement: "INCOME STATEMENT" } }, PERIOD, "company");
  const r = await verify(read, { 5: spanning(["Underlying", "Non-underlying", "Total"]) });
  assertEqual(r.diagnostics[0].ocr, "257.7", "total column");
  assertEqual(r.lines.operating_profit.tag, "verified", "confirmed");
  // The same page read as a group's still abstains on basis: nothing printed says group (WP-GRPCHK).
  const asGroup = firstRead({ operating_profit: { ...found("operating_profit", "257.7", "Operating profit", 5), statement: "INCOME STATEMENT" } });
  const g = await verify(asGroup, { 5: spanning(["Underlying", "Non-underlying", "Total"]) });
  assertEqual(g.lines.operating_profit.tag, "rejected", "a group filer with no group heading");
  assert(/basis/.test(g.overrides.operating_profit!.reason), g.overrides.operating_profit!.reason);
  const under = firstRead({ operating_profit: { ...found("operating_profit", "268.1", "Operating profit", 5), statement: "INCOME STATEMENT" } }, PERIOD, "company");
  const u = await verify(under, { 5: spanning(["Underlying", "Non-underlying", "Total"]) });
  assertEqual(u.lines.operating_profit.tag, "rejected", "the underlying figure is not the line's figure");
});

test("a spanning heading with sub-columns and no Total is ambiguous and abstains", async () => {
  const read = firstRead({ operating_profit: { ...found("operating_profit", "257.7", "Operating profit", 5), statement: "INCOME STATEMENT" } });
  const r = await verify(read, { 5: spanning(["Continuing", "Discontinued", "Other"]) });
  assertEqual(r.diagnostics[0].code, OCR_ABSTAIN.ambiguousColumn, "code");
});

test("side-by-side panels are read as separate lines", () => {
  const layer: OcrPageLayer = {
    engine: "fixture",
    page: 1,
    width: 595,
    height: 842,
    observations: [o("Goodwill", 0.06, 0.34, 0.1), o("5,092", 0.39, 0.34, 0.42), o("5,087", 0.46, 0.34, 0.49), o("Borrowings", 0.51, 0.34, 0.55), o("22", 0.78, 0.34, 0.79), o("(5,372)", 0.84, 0.34, 0.86)],
  };
  const rows = rowsOf(layer);
  assertEqual(rows.length, 1, "one printed row");
  const segs = segmentsOf(rows[0], 0);
  assertEqual(segs.length, 2, "two lines");
  assertEqual(segs[1].label.map((t) => t.text).join(" "), "Borrowings", "second label");
});

test("label matching: net, non and the other deciding words are never ignored", () => {
  assertEqual(labelScore("Net current liabilities", "Current liabilities"), 0, "net");
  assertEqual(labelScore("Non-current liabilities total", "Current liabilities"), 0, "non");
  assert(labelScore("Current liabilities total", "Current liabilities") === 1, "total is not a deciding word");
});

test("ocrSecondRead never uses the first read's figure: the wire carries OCR's own text", () => {
  const read = firstRead({ cash_at_bank: found("cash_at_bank", "9.9", "Cash and cash equivalents") });
  const s = ocrSecondRead(read, new Map([[10, balanceSheet()]]));
  assertEqual(s.wire.lines[0].figure_text, "1.7", "OCR text");
});

test("a real stored layer: PizzaExpress statement of financial position, page 9", async () => {
  const path = join(HERE, "..", "eval", "gold", "uk", "ocr", "MzQ4MjMyMTE4OWFkaXF6a2N4", "p9.json");
  assert(existsSync(path), "stored layer present");
  const layer = JSON.parse(readFileSync(path, "utf8")) as OcrPageLayer;
  const f = (figureText: string, label: string): FoundLine => ({ ...found("cash_at_bank", figureText, label, 9, "£000"), periodEnd: "2024-12-29", statement: "Statement of Financial Position" });
  const read = { ...firstRead({ cash_at_bank: f("17,375", "Cash and cash equivalents"), net_assets: f("(74,530)", "Net liabilities") }, "2024-12-29", "company"), transactionId: "MzQ4MjMyMTE4OWFkaXF6a2N4" };
  const pages = memoryPageSource({ "MzQ4MjMyMTE4OWFkaXF6a2N4:9": layer });
  const r = await new OcrSecondReadVerifier({ pages }).verify({ read, pdfBytes: new Uint8Array(), pageCount: 26 });
  assertEqual(r.lines.cash_at_bank.tag, "verified", "cash");
  assertEqual(r.lines.net_assets.tag, "verified", "net liabilities");
  const wrong = { ...read, lines: { ...read.lines, cash_at_bank: f("17,875", "Cash and cash equivalents") } };
  const w = await new OcrSecondReadVerifier({ pages }).verify({ read: wrong, pdfBytes: new Uint8Array(), pageCount: 26 });
  assertEqual(w.lines.cash_at_bank.tag, "rejected", "one digit wrong");
  const applied = applyVerification(wrong, w);
  assertEqual(applied.read.lines.cash_at_bank.status, "abstain", "abstained, never corrected");
});

test("the flag: the model second read stays the default; VISION_SECOND_READ=ocr selects OCR", () => {
  assertEqual(secondReadMode(undefined), "model", "unset");
  assertEqual(secondReadMode("model"), "model", "model");
  assertEqual(secondReadMode(" OCR "), "ocr", "ocr");
  assertEqual(createVisionVerifier({ provider: null }, "model").name, DOUBLE_READ_VERIFIER_NAME, "model verifier");
  assertEqual(createVisionVerifier({}, "ocr").name, OCR_VERIFIER_NAME, "ocr verifier");
});

test("the disk page source without a binary reads the cache only and never OCRs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocr-cache-"));
  const r = await diskPageSource({ dir, bin: null }).page(new Uint8Array(), "tx", 3);
  assert(!r.ok && /may not OCR/.test(r.reason), "abstains without OCR");
  const stored = await diskPageSource({ dir: join(HERE, "..", "eval", "gold", "uk", "ocr"), bin: null }).page(new Uint8Array(), "MzQ4MjMyMTE4OWFkaXF6a2N4", 9);
  assert(stored.ok && stored.fromCache, "reads a stored page");
});

test("peak memory is parsed from /usr/bin/time -l", () => {
  const m = timeMeasures("       0.70 real         0.35 user\n           224460800  maximum resident set size\n           396477400  peak memory footprint\n");
  assertEqual(m.peakBytes, 396477400, "peak");
  assertEqual(m.maxRssBytes, 224460800, "rss");
});
