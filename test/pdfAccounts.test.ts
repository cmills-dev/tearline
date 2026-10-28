// test/pdfAccounts.test.ts
// The text-layer extractor is pure, so it tests offline against synthetic accounts text.
// Confirms labelled lines are read with correct scale and sign, and that it abstains
// (returns null) on doubt: no declared scale, an internal scale mismatch, or nothing found.

import { suite, test, assert, assertEqual } from "./harness";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyPdf, extractFinancialsFromText, detectScale, pdfDeclaresFont } from "../lib/sources/pdfAccounts";

const HERE = dirname(fileURLToPath(import.meta.url));

const ACCOUNTS = [
  "NORTHWIND TRADING LIMITED",
  "Statement of comprehensive income for the year ended 31 December 2024",
  "Figures in £'000                              2024      2023",
  "Turnover                                    152,300   148,100",
  "Cost of sales                              (110,400) (108,900)",
  "Operating profit                             24,900    22,100",
  "Interest payable                             (3,200)   (3,050)",
  "Balance sheet as at 31 December 2024",
  "Cash and cash equivalents                    12,500     9,800",
  "Loans and borrowings                         86,000    90,000",
].join("\n");

suite("pdfAccounts / scale detection");

test("detects thousands and millions captions, abstains when none", () => {
  assertEqual(detectScale("Figures in £'000"), 1000, "£'000 -> x1000");
  assertEqual(detectScale("all figures in £m"), 1_000_000, "£m -> x1,000,000");
  assertEqual(detectScale("Turnover 152,300 148,100"), null, "no caption -> null (abstain)");
});

suite("pdfAccounts / extraction");

const ex = extractFinancialsFromText(ACCOUNTS)!;
const v = (m: string) => ex.lines.find((l) => l.metric === m)?.value;

test("reads the current-year column, scaled, from labelled lines", () => {
  assert(ex !== null, "extraction returned");
  assertEqual(ex.scale, 1000, "scale from the £'000 caption");
  assertEqual(v("turnover"), 152_300_000, "turnover = 152,300 x 1000 (2024 column)");
  assertEqual(v("operatingProfit"), 24_900_000, "operating profit scaled");
  assertEqual(v("cash"), 12_500_000, "cash scaled");
  assertEqual(v("borrowings"), 86_000_000, "borrowings scaled");
});

test("each line keeps its verbatim source text as the grounding snippet", () => {
  const t = ex.lines.find((l) => l.metric === "turnover");
  assert(!!t && /Turnover\s+152,300/.test(t.rawText), "turnover snippet is the source line");
  assert(!!t && t.concept.startsWith("pdf:"), "concept marks the PDF text-layer source");
});

test("abstains entirely when no scale is declared (avoids a 1,000x error)", () => {
  const noScale = ACCOUNTS.replace("Figures in £'000", "Figures");
  assertEqual(extractFinancialsFromText(noScale), null, "no declared scale -> null");
});

test("skips a leading note-reference column and reads the figure, not the note number", () => {
  const withNotes = [
    "Figures in £'000                    Note      2024      2023",
    "Turnover                              3     152,300   148,100",
    "Operating profit                      5      24,900    22,100",
    "Cash and cash equivalents            12       1,235       980",
    "Loans and borrowings                 14      86,000    90,000",
  ].join("\n");
  const r = extractFinancialsFromText(withNotes)!;
  const val = (m: string) => r.lines.find((l) => l.metric === m)?.value;
  assertEqual(val("turnover"), 152_300_000, "turnover reads 152,300, not the note number 3");
  assertEqual(val("cash"), 1_235_000, "cash reads 1,235, not the note number 12");
  assertEqual(val("borrowings"), 86_000_000, "borrowings reads 86,000, not the note number 14");
});

test("leaves a single-figure row untouched (no note column to skip)", () => {
  const single = ["Figures in £'000", "Cash and cash equivalents 9,800"].join("\n");
  const r = extractFinancialsFromText(single)!;
  assertEqual(r.lines.find((l) => l.metric === "cash")?.value, 9_800_000, "single figure read directly");
});

test("abstains when operating profit exceeds turnover (a scale/column misread)", () => {
  const broken = [
    "Figures in £'000",
    "Turnover 1,000 900",
    "Operating profit 200,000 190,000",
  ].join("\n");
  assertEqual(extractFinancialsFromText(broken), null, "internal scale mismatch -> abstain");
});

suite("pdfAccounts / the three false figures from the audit");

// docs/programme/audit/backend-engine.md finding 3. Each of these read as a figure and landed at
// R1. A statement row prints a label and then figures, so a row with prose after the label is not
// a statement row, and a row whose first token could be a note number with nothing clearly a
// figure after it is ambiguous. Both abstain.

test('"Turnover 2024 up on 2023" does not read turnover as 2,024,000', () => {
  const text = ["Figures in £'000", "Turnover 2024 up on 2023"].join("\n");
  assertEqual(extractFinancialsFromText(text), null, "prose after the label is not a statement row");
});

test('"Borrowings of 3 facilities were refinanced" does not read borrowings as 3,000,000', () => {
  const text = ["all figures in £m", "Borrowings of 3 facilities were refinanced in the year"].join("\n");
  assertEqual(extractFinancialsFromText(text), null, "prose after the label is not a statement row");
});

test('"Cash at bank and in hand 12 5" does not read cash as 12,000', () => {
  const text = ["Figures in £'000", "Cash at bank and in hand 12 5"].join("\n");
  assertEqual(extractFinancialsFromText(text), null, "note column or figure column: abstain");
});

test("a real statement row beneath the prose is still read", () => {
  const text = [
    "Figures in £'000",
    "Turnover 2024 up on 2023, driven by volume",
    "Turnover                     152,300   148,100",
  ].join("\n");
  const r = extractFinancialsFromText(text)!;
  assertEqual(r.lines.find((l) => l.metric === "turnover")?.value, 152_300_000, "the statement row wins");
});

suite("pdfAccounts / scan or text layer");

test("a PDF with no font declaration is a scan", () => {
  const scan = new TextEncoder().encode("%PDF-1.4\n/Type /XObject /Subtype /Image /Filter /DCTDecode\n");
  assertEqual(classifyPdf(scan, "  ", 28), "scan", "no font, two characters of text");
});

test("a PDF with fonts and a full text layer keeps the deterministic path", () => {
  const doc = new TextEncoder().encode("%PDF-1.4\n/Type /Font /BaseFont /Helvetica\n");
  const text = "x".repeat(28 * 400);
  assertEqual(classifyPdf(doc, text, 28), "text-layer", "fonts and hundreds of characters a page");
});

test("a PDF with fonts but almost no text is still a scan", () => {
  const doc = new TextEncoder().encode("%PDF-1.4\n/Type /Font /BaseFont /Helvetica\n");
  assertEqual(classifyPdf(doc, "Scanned by a photocopier", 28), "scan", "too little text for the page count");
});

// WP-BE14-LIVE-2. The live fetch stage no longer extracts the text layer of a PDF that declares no
// font: on a 210-page scan that took 39 to 71 s, past the 30 s fetch slice (Bellis Finco timed out
// in fetch). Skipping it cannot change the verdict, because no font is a scan whatever the text.
test("no font is a scan whatever the text, so the fetch stage need not extract it", () => {
  const scan = new TextEncoder().encode("%PDF-1.4\n/Type /XObject /Subtype /Image /Filter /DCTDecode\n");
  assertEqual(classifyPdf(scan, "x".repeat(28 * 400), 28), "scan", "a full text layer does not rescue a fontless PDF");
  assertEqual(classifyPdf(scan, "", 28), "scan", "and the empty text the fetch stage now passes gives the same answer");
});

test("the font test on the 13.5 MB, 210-page James Fisher scan says scan in well under a second", () => {
  const bytes = new Uint8Array(readFileSync(join(HERE, "../eval/gold/fixtures/uk/00211475-2025-12-31/filing.pdf")));
  const t0 = Date.now();
  assertEqual(pdfDeclaresFont(bytes), false, "James Fisher's scan declares no font");
  assert(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
});
