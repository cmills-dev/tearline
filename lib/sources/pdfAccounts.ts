// lib/sources/pdfAccounts.ts
// UK PDF accounts, text-layer first. Large UK filers lodge PDF accounts at Companies
// House (no iXBRL), so this reads the PDF's embedded text layer and pulls labelled
// financial lines deterministically: no model, and the exact source line is kept as the
// grounding snippet. Per docs/extraction-strategy.md the text layer is the source of
// truth for digits; a managed document-AI or a VLM is the gated fallback for scans and
// pathological tables (not built here, and never trusted without the same guards).
//
// The extractor is CONSERVATIVE by design: it matches a small set of statement labels,
// takes the first monetary figure on the label's line (the current-year column), applies
// scale and sign deterministically, and ABSTAINS on doubt (no scale, an internal scale
// mismatch, or nothing found) rather than emitting a shaky number.

import type { ExtractedLine } from "./ixbrl";
import { precisionFromPrinted } from "../engine/precision";
import { BASIS_ABSTAIN, captionSpans, headingBasis, isStatementHeading, printsGroupStatement, type HeadingBasis } from "../vision/basisWords";

// Label -> base metric. Ordered specific-before-generic so "operating profit" is not
// swallowed by a bare "profit". Matched case-insensitively as a line prefix-ish anchor.
const LABELS: { metric: string; label: string; re: RegExp }[] = [
  { metric: "turnover", label: "Turnover (revenue)", re: /\b(turnover|revenue)\b/i },
  { metric: "operatingProfit", label: "Operating profit", re: /\boperating (profit|loss)\b/i },
  {
    metric: "depreciationAmortisation",
    label: "Depreciation and amortisation",
    re: /\bdepreciation(?: and| ?[,] ?)? amortisation\b/i,
  },
  { metric: "cash", label: "Cash and cash equivalents", re: /\bcash (?:and cash equivalents|at bank(?: and in hand)?)\b/i },
  { metric: "borrowings", label: "Total borrowings", re: /\b(?:loans and borrowings|bank loans and borrowings|total borrowings|borrowings)\b/i },
  { metric: "netInterest", label: "Interest expense", re: /\binterest (?:payable(?: and similar (?:expenses|charges))?|expense)\b/i },
];

// A printed monetary figure: optional parentheses (negative), optional currency, digit
// groups with optional thousands separators and decimals. Captured so we can read sign.
// A minus sign counts only when it is attached to the figure ("-1,234"); a dash standing alone
// is a nil column (below), and reading it as a sign would turn "– 250" into -250.
const MONEY = /(?:[-−](?=[£$€]?\d))?\(?\s*[£$€]?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*\)?/;
// A dash printed for nil, standing alone in its column. It must stay in the token list: dropped,
// the next column moves up, so "14 – 250" (note, nil this year, 250 last year) read as 250 and
// "14 – –" read the note number 14 as the figure (WP-QA03 N1).
const NIL = /(?<![\w\d])[-–—−](?=\s|$)/;
const TOKEN_G = new RegExp(`${NIL.source}|${MONEY.source}`, "g");
const isNil = (tok: string) => new RegExp(`^${NIL.source}$`).test(tok);

// Lines whose nature is an expense. The text layer prints them either way ("Interest payable
// (1,234)" or "1,234"); the engine wants the magnitude, as visionAccounts' nature rule gives on
// the scan path. A bracketed interest line otherwise gave a negative interest cover (WP-QA03 N2).
const EXPENSE_METRICS = new Set(["netInterest", "depreciationAmortisation"]);

// Scale captions ("in thousands", "£'000", "£000", "£ thousands", "£m", "£'m", "£ millions").
// Absent a declared scale we do NOT guess a multiplier (that is the classic 1,000x error); we
// return null, and the caller abstains rather than emit an unscaled figure.
const SCALE_CAPTIONS: { re: RegExp; scale: number }[] = [
  { re: /£\s*['’]?\s*0{6}\b/g, scale: 1_000_000 },
  { re: /£\s*['’]?\s*0{3}\b|in thousands|figures in £?000|£\s*thousands?\b|thousands of pounds/g, scale: 1_000 },
  { re: /£\s*['’]?\s*mn?\b|in millions|figures in £?m\b|£\s*millions?\b|millions of pounds/g, scale: 1_000_000 },
];

// The first thousands or millions caption printed in the text, by position. Within one line
// this is the current-year column's caption, which comes first.
function firstCaption(text: string): number | null {
  const t = text.toLowerCase();
  let best: { at: number; scale: number } | null = null;
  for (const { re, scale } of SCALE_CAPTIONS) {
    re.lastIndex = 0;
    const m = re.exec(t);
    if (m && (!best || m.index < best.at)) best = { at: m.index, scale };
  }
  return best?.scale ?? null;
}

// The document default. One caption per PDF was the whole design until WP-QA03 D1: the thousands
// pattern was tried first, so a £m group with a £'000 remuneration table read every statement
// figure 1,000 times too small, and the operating-profit tripwire cannot see an error that is the
// same on every line. Each block now reads its own caption (scaleForLines below). The default is
// for a block that prints none: the caption of the first primary statement that prints one (the
// notes do not count), else the first caption anywhere, else a caption for whole pounds. The
// notes are left out so a "Figures in £'000" printed once at the top is not overridden by one
// £m note table further on.
export function detectScale(text: string): number | null {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim());
  const fromStatements = firstStatementCaption(lines);
  const anywhere = fromStatements ?? firstCaption(text);
  if (anywhere !== null) return anywhere;
  // Statements in whole pounds are common for small filers; treat an explicit "in £" or
  // no scale caption as unit scale ONLY when figures look like whole pounds (>= 4 digits).
  if (/in £\b|figures are in pounds|£ ?1\b/.test(text.toLowerCase())) return 1;
  return null;
}

const endsBlock = (line: string) => looksLikeHeading(line) || NOTE_HEADING.test(line);

function firstStatementCaption(lines: string[]): number | null {
  let inStatement = false;
  for (const line of lines) {
    if (endsBlock(line)) inStatement = isStatementHeading(line) && !/\bnotes to\b/i.test(line);
    if (!inStatement || HAS_FIGURE.test(line)) continue; // a row's own caption is not the block's
    const caption = firstCaption(line);
    if (caption !== null) return caption;
  }
  return null;
}

// The caption a single line prints, or null. Whole pounds count only when said in words:
// "£1" on a line is far more often "ordinary shares of £1 each" than a caption.
export function lineScale(line: string): number | null {
  const caption = firstCaption(line);
  if (caption !== null) return caption;
  if (/\b(?:figures|amounts) (?:are )?(?:stated |presented )?in (?:pounds|£)(?!\s*['’]?\s*(?:0|m\b|mn\b|thousand|million))|in pounds sterling/i.test(line)) return 1;
  return null;
}

// A numbered note heading such as "12 Directors' remuneration" or "14. Borrowings": a note
// number and words, no figure. It closes the block above, as a statement heading does.
// A date split over a line ("31 December") is not a note heading.
const NOTE_HEADING =
  /^(?:note\s+)?\d{1,2}[a-z]?[.)]?\s+(?!(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b)[A-Za-z][A-Za-z ,'’&()\-]{2,80}$/i;
// A figure with a thousands separator or decimals: the line is a statement row, not a caption.
const HAS_FIGURE = /\d,\d{3}|\d\.\d/;

// A caption governs the rows below it until the next statement or note heading, where the scale
// goes back to the document default. A caption printed on a row that also carries a figure
// ("Revenue £m 1,234.5") scales that row only. Returns the scale each line is read at.
export function scaleForLines(rawLines: string[], documentScale: number): number[] {
  let block = documentScale;
  return rawLines.map((line) => {
    const own = lineScale(line);
    if (endsBlock(line)) {
      block = own ?? documentScale;
      return block;
    }
    if (own === null) return block;
    if (HAS_FIGURE.test(line)) return own; // a row with its own caption
    block = own; // a caption line or a column header ("2025 £m 2024 £m")
    return block;
  });
}

function parseMoney(token: string, scale: number): number | null {
  const trimmed = token.trim();
  const negative = /^\(.*\)$/.test(trimmed) || trimmed.startsWith("-") || trimmed.startsWith("−");
  const digits = trimmed.replace(/[()£$€,\s\-−]/g, "");
  if (!/^\d+(?:\.\d+)?$/.test(digits)) return null;
  const n = parseFloat(digits) * scale;
  if (!isFinite(n)) return null;
  return negative ? -n : n;
}

// A leading token is a NOTE-REFERENCE column, not a figure, when it is a bare 1-2 digit
// integer (1..99) with no thousands separator, decimal, currency or parentheses. UK
// statutory statements print "Label  Note  CurrentYear  PriorYear".
function isNoteRef(tok: string): boolean {
  return /^\d{1,2}$/.test(tok) && Number(tok) >= 1 && Number(tok) <= 99;
}
// A token that is clearly a monetary figure: a thousands separator or decimal, three or
// more integer digits, or a currency/parenthesis marker. Used only to confirm a later
// column exists before discarding a leading note reference.
function isFigure(tok: string): boolean {
  return /[,.]/.test(tok) || /\d{3,}/.test(tok.replace(/[^\d]/g, "")) || /[()£$€]/.test(tok);
}

// A statement row prints a label and then figures. Anything else after the label is prose, and
// prose is where the false figures came from (audit finding 3: "Turnover 2024 up on 2023" read
// as 2,024,000, "Borrowings of 3 facilities were refinanced" read as 3,000,000). So the tail of
// a row must carry no words. Currency marks, scale captions and a bare "p" for pence are not
// words; anything with two or more letters is.
const TAIL_WORD = /[A-Za-z]{2,}/;
function isStatementTail(tail: string): boolean {
  const stripped = tail
    .replace(/[£$€]/g, " ")
    .replace(/\b(?:000|m|bn|k|p)\b/gi, " ")
    .replace(/\bnote\b/gi, " ");
  return !TAIL_WORD.test(stripped);
}

// The current-year monetary figure on a statement row. Takes the first money token AFTER the
// label, but first discards a leading note-reference column: "Cash at bank 15 1,234,567" must
// read 1,234,567, not the note number 15. Where the leading token could be a note number and no
// later token is clearly a figure, the row is ambiguous ("Cash at bank and in hand 12 5", note
// 12 and figure 5) and the line abstains rather than reading the note as the figure.
// A note reference printed in words, "(note 21)" or "note 21", is not a figure. Left in, the
// parenthesised form read as a negative 21 of the statement's scale (found on Boparan's note 19,
// WP-GRPCHK: "Other borrowings (note 21) - 9.8 - 9.8").
const NOTE_WORDS = /\(?\s*\bnotes?\s+\d{1,2}[a-z]?(?:\s*[,&]\s*\d{1,2}[a-z]?)*\s*\)?/gi;
// A figure, or a dash printed where a column has no figure.
// The dash looks behind for its space, because a figure before it has already taken that space.
const SLOT_G = new RegExp(`${MONEY.source}|(?<=^|\\s)[-–—](?=\\s|$)`, "g");


function figureOnLabelLine(line: string, re: RegExp, scale: number, miss?: (reason: string) => void): { value: number; raw: string; figure: string } | null {
  const m = re.exec(line);
  if (!m) return null;
  const after = line.slice(m.index + m[0].length).replace(NOTE_WORDS, " ");
  if (!isStatementTail(after)) return null;
  // The first column is the current year (or, on a Group and Company table, the group's current
  // year). A dash there means the column is blank on this row, and the first figure printed
  // belongs to a later column: a comparative, or the company's. Taking it is the wrong-column
  // error, so the row gives no figure.
  // A leading note reference column ("Investment in associate 14 - 7.4") does not count.
  const slots = (after.match(SLOT_G) ?? []).map((t) => t.trim());
  const first = slots.length > 2 && isNoteRef(slots[0]) ? 1 : 0;
  if (slots.length - first > 1 && /^[-–—]$/.test(slots[first])) {
    miss?.(`the first column prints "${slots[first]}" on the row "${line.trim()}", so the first figure on it belongs to another column`);
    return null;
  }
  // Nil dashes stay in the token list so the columns keep their places (WP-QA03 N1).
  const tokens = (after.match(TOKEN_G) ?? []).map((t) => t.trim());
  if (tokens.length === 0) return null;

  let idx = 0;
  if (tokens.length > 1 && isNoteRef(tokens[0])) {
    const figureIdx = tokens.findIndex((t, i) => i > 0 && isFigure(t));
    if (figureIdx < 0) return null; // note column or figure column? abstain rather than guess
    idx = figureIdx;
  }
  // The current-year column is the first after any note reference. A nil there, or a nil the
  // search stepped over to reach a figure, means this year printed nothing: abstain rather than
  // read a later column as this year's.
  // The check above catches a dash in the first column; this one also catches a nil the note
  // search stepped over, and "−", which the slot pattern does not know.
  const firstCol = tokens.length > 1 && isNoteRef(tokens[0]) ? 1 : 0;
  if (tokens.slice(firstCol, idx + 1).some(isNil)) {
    miss?.(`this year's column prints nil on the row "${line.trim()}", so the figure on it belongs to another column`);
    return null;
  }
  const value = parseMoney(tokens[idx], scale);
  if (value === null) return null;
  return { value, raw: line.trim(), figure: tokens[idx] };
}

export interface PdfAbstention {
  metric: string;
  label: string;
  reason: string;
}

export interface PdfExtraction {
  scale: number;
  lines: ExtractedLine[];
  // Labelled rows that were found and not taken, for a line that then gave no figure at all: the
  // reason is landed on the sheet so the gap says why (WP-GRPCHK).
  abstentions: PdfAbstention[];
  // Why the filing was held to the basis check, or null when it was not.
  groupFiler: string | null;
}

export interface TextExtractOptions {
  // The resolver's accounts type (lib/resolve/accountsType.ts). "group" holds the filing to the
  // basis check; so does a text layer that prints a group statement heading.
  accountsType?: string | null;
}

// The basis check on the text layer (WP-GRPCHK). The scan path has had it since WP-BE18; the text
// layer took the first labelled row and the first figure on it, whoever's statement or column it
// sat in. A group files two balance sheets and both tie, and many print Group and Company columns
// side by side in one table. So on a group filer each labelled row is judged by the words printed
// above it: the nearest statement heading, and the nearest row of column captions.
//   - under a company heading ("Company balance sheet", "Parent company statement of financial
//     position"): not taken;
//   - under captions that print Company before Group: not taken, the first figure is the company's;
//   - with no group wording above it at all (no group heading, no Group caption): not taken;
//   - under "Consolidated and company balance sheets" (mixed), the captions must print Group first.
// A row not taken does not end the search: the group's row further on is still read. A line that
// finds no row it may take abstains, and the reason names the heading or caption that stopped it.
function textGroupFilerWhy(rawLines: string[], accountsType: string | null | undefined): string | null {
  if (accountsType === "group") return "the filing is group accounts";
  const printed = rawLines.find((l) => l.length <= 140 && printsGroupStatement(l));
  if (!printed) return null;
  const registerWords = accountsType ? `, though the register calls it "${accountsType}" accounts` : "";
  return `the filing is a group's: it prints "${printed}"${registerWords}`;
}

function looksLikeHeading(line: string): boolean {
  // A statement heading, not a statement row: short, and carrying no figure with a thousands
  // separator or decimals (a heading may carry a date, "at 31 December 2025").
  return line.length <= 140 && isStatementHeading(line) && !/\d,\d{3}|\d\.\d/.test(line);
}

interface RowContext {
  heading: { text: string; basis: HeadingBasis } | null;
  caption: { text: string; spans: ("group" | "company")[] } | null;
}

function basisProblemForRow(ctx: RowContext, why: string): string | null {
  const h = ctx.heading;
  const c = ctx.caption;
  if (h?.basis === "company") return `${BASIS_ABSTAIN}: ${why}, but the row sits under "${h.text}", the company's own statement`;
  if (c && c.spans[0] === "company") {
    return `${BASIS_ABSTAIN}: ${why}, but the columns are captioned "${c.text}", so the first figure on the row is the company's`;
  }
  if (c && c.spans[0] === "group") return null;
  if (h?.basis === "group") return null;
  if (h?.basis === "mixed") {
    return `${BASIS_ABSTAIN}: ${why}, and the row sits under "${h.text}", which covers both, with no Group column caption to say which figure is the group's`;
  }
  return `${BASIS_ABSTAIN}: ${why}, and nothing printed above the row says "consolidated" or "group"${h ? ` (statement "${h.text}")` : ""}, so it could be the company's own`;
}

// Pure: read labelled financial lines from accounts text. sourceTag marks provenance
// ("pdf" text-layer or "ocr" scanned-page OCR). Returns null when nothing usable is found
// or an internal scale check fails (abstain, never a guessed number).
export function extractFinancialsFromText(
  text: string,
  sourceTag: "pdf" | "ocr" = "pdf",
  options: TextExtractOptions = {}
): PdfExtraction | null {
  if (!text || text.length < 40) return null;
  const scale = detectScale(text);
  if (scale === null) return null; // no declared scale -> abstain (avoid a 1,000x error)

  const rawLines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const groupFiler = textGroupFilerWhy(rawLines, options.accountsType);
  // Each line is read at the scale of the block it sits in (WP-QA03 D1).
  const scales = scaleForLines(rawLines, scale);

  // The words printed above each line: the nearest statement heading, and the nearest caption row
  // since that heading.
  const context: RowContext[] = [];
  let ctx: RowContext = { heading: null, caption: null };
  for (const line of rawLines) {
    if (looksLikeHeading(line)) ctx = { heading: { text: line, basis: headingBasis(line) }, caption: null };
    else {
      const spans = captionSpans(line);
      if (spans) ctx = { ...ctx, caption: { text: line, spans } };
    }
    context.push(ctx);
  }

  const found = new Map<string, { value: number; raw: string; figure: string }>();
  const missed = new Map<string, string>(); // metric -> the first reason a labelled row was not taken

  for (const { metric, re } of LABELS) {
    if (found.has(metric)) continue;
    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i];
      const miss = (reason: string) => {
        if (!missed.has(metric)) missed.set(metric, reason);
      };
      const hit = figureOnLabelLine(line, re, scales[i], miss);
      if (!hit) continue;
      if (groupFiler) {
        const problem = basisProblemForRow(context[i], groupFiler);
        if (problem) {
          miss(`${problem}: "${line}"`);
          continue;
        }
      }
      if (EXPENSE_METRICS.has(metric)) hit.value = Math.abs(hit.value);
      found.set(metric, hit);
      break; // first labelled row it may take wins (the primary statement)
    }
  }

  const labelOf = (metric: string) => LABELS.find((l) => l.metric === metric)?.label ?? metric;
  const abstentions: PdfAbstention[] = [...missed.entries()]
    .filter(([metric]) => !found.has(metric))
    .map(([metric, reason]) => ({ metric, label: labelOf(metric), reason }));

  if (found.size === 0) return abstentions.length ? { scale, lines: [], abstentions, groupFiler } : null;

  // Internal scale tripwire: operating profit cannot exceed turnover. A hit here almost
  // always means a column/scale misread, so we abstain on BOTH rather than surface a
  // wrong figure. This is the abstain-on-doubt rule applied at the source.
  const to = found.get("turnover")?.value;
  const op = found.get("operatingProfit")?.value;
  if (to != null && op != null && to > 0 && op > to * 1.02) {
    return null;
  }

  const meta = LABELS.reduce<Record<string, string>>((a, l) => ((a[l.metric] = l.label), a), {});
  const lines: ExtractedLine[] = [...found.entries()].map(([metric, { value, raw, figure }]) => ({
    metric,
    label: meta[metric] ?? metric,
    unit: "GBP",
    value,
    concept: `${sourceTag}:${metric}`,
    contextRef: "",
    periodEnd: "",
    rawText: raw, // the verbatim source line: the grounding snippet
    precision: precisionFromPrinted(figure, scale),
  }));

  return { scale, lines, abstentions, groupFiler };
}

// ---------------------------------------------------------------------------
// Scan or text layer
// ---------------------------------------------------------------------------
// How to tell them apart, and why it matters: Companies House serves most accounts PDFs as
// images. The audit measured this (findings 12, 13 and 17): twelve of thirteen sampled filings
// were produced by `tiff2pdf`, declared zero embedded fonts, held one DCT image per page, and
// gave a text layer of two characters. The extractor above cannot ever work on those, and when
// it half-works it invents figures, so on a scan it must not run at all.
//
// Two independent tests, either of which means "scan":
//   1. No font. A PDF with a real text layer declares at least one font object (/Type /Font or
//      /BaseFont). An image-only scan declares none.
//   2. Too little text for the page count. A genuine set of accounts carries hundreds of
//      characters a page. A scan carries a handful, usually a stray producer string.
// A filing that passes both keeps the deterministic text-layer path, which is free and exact.
// Everything else goes to the vision reader.

export type PdfKind = "text-layer" | "scan";

export const MIN_TEXT_CHARS_PER_PAGE = 120;
export const MIN_TEXT_CHARS = 400;

export function pdfDeclaresFont(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes).toString("latin1");
  return /\/Type\s*\/Font\b/.test(head) || /\/BaseFont\b/.test(head);
}

// pageCount of 0 or less means "not known", in which case only the absolute character floor and
// the font test apply.
export function classifyPdf(bytes: Uint8Array, text: string, pageCount: number): PdfKind {
  if (!pdfDeclaresFont(bytes)) return "scan";
  const chars = text.trim().length;
  if (chars < MIN_TEXT_CHARS) return "scan";
  if (pageCount > 0 && chars / pageCount < MIN_TEXT_CHARS_PER_PAGE) return "scan";
  return "text-layer";
}

// PDF bytes -> text, via unpdf (pure JS, serverless-friendly pdf.js). Import is dynamic
// so the CH iXBRL path never loads the PDF stack. Returns "" on any failure.
export async function pdfToText(data: Uint8Array): Promise<string> {
  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    // pdf.js takes ownership of the buffer it is given and detaches it, which empties the
    // caller's Uint8Array. The live path reads the same bytes afterwards (classifyPdf, then the
    // vision reader and the second read), so pdf.js gets a copy (found in WP-BE05).
    const pdf = await getDocumentProxy(data.slice());
    const result = await extractText(pdf, { mergePages: true });
    const text: unknown = (result as { text?: unknown }).text;
    if (typeof text === "string") return text;
    if (Array.isArray(text)) return text.join("\n");
    return "";
  } catch {
    return "";
  }
}
