// lib/vision/ocrSecondRead.ts
// The second read on local OCR instead of a model call (WP-OCR2, RS-02 rank 2).
//
// The model second read (lib/vision/secondRead.ts) is a second opinion from the same model family,
// which RS-02 found proves less than it seems to. This one reads the same page through a different
// channel: Apple Vision OCR of the page, with the box of every piece of text on it
// (lib/ocr/pageLayer.ts). For every figure the first read surfaced it finds, on the cited page:
//
//   1. the line: the row whose printed label is the first read's printed label. The label is only a
//      locator, so it must also name the key in its own printed words (KEY_WORDS below): a first
//      read that put "Other creditors" under borrowings cannot be confirmed by finding "Other
//      creditors" again;
//   2. the column: the column headed with the accounts period, found from the headings printed
//      above the row, never from where the first read said the figure was;
//   3. the figure OCR reads where that row and that column cross, with its own digits, brackets or
//      minus, and the unit caption printed over the column or at the head of the statement.
//
// What it reads becomes a SecondReadWire, and the judgement is the one the model second read gets:
// judgeDoubleRead in lib/vision/verify.ts compares value, sign and scale, establishes the scale
// and currency from the caption, the period from the column heading, the basis from the printed
// headings, and runs the printed ties. So agreement confirms and anything else abstains with a
// reason, exactly as before; only the reader changed. A line OCR cannot place abstains with a
// named reason (OCR_ABSTAIN), and the first read's figure is never used to choose a row or a column.

import { scaleFromCaption } from "./scale";
import { readPrintedFigure } from "./schema";
import type { SecondReadWire, SecondWireLine, SecondWireTieLine, TieRole } from "./secondRead";
import { TIE_ROLES } from "./secondRead";
import { BASE_LINE_KEYS, type BaseLineKey, type FoundLine, type VisionReadResult } from "./types";
import { headingBasis, periodFromHeadings } from "./verify";
import type { OcrObservation, OcrPageLayer } from "../ocr/pageLayer";

// v2 (WP-BE23): the lease line is three keys, each held to its own section.
export const OCR_SECOND_READ_VERSION = "v2";
export const OCR_VERIFIER_NAME = `ocr-read/${OCR_SECOND_READ_VERSION}`;

// Why OCR could not give a figure for a line. Each is an abstention, never a disagreement.
export const OCR_ABSTAIN = {
  noLayer: "no-ocr-layer",
  noLabel: "label-not-found",
  ambiguousLabel: "label-ambiguous",
  labelNotKey: "label-does-not-name-key",
  noColumn: "period-column-not-found",
  ambiguousColumn: "period-column-ambiguous",
  emptyCell: "no-figure-in-period-column",
  unreadable: "figure-unreadable",
} as const;
export type OcrAbstainCode = (typeof OCR_ABSTAIN)[keyof typeof OCR_ABSTAIN];

// ---------------------------------------------------------------------------
// Rows and tokens
// ---------------------------------------------------------------------------

export interface Token {
  text: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  figure: boolean; // prints a figure: digits with optional commas, decimals, brackets or minus
  dash: boolean; // prints a nil: "-" or "—" alone
}

export interface Row {
  tokens: Token[];
  y0: number;
  y1: number;
}

const FIGURE = /^\(?[-−–]?[£$€]?\d{1,3}(?:,\d{3})*(?:\.\d+)?\)?$|^\(?[-−–]?[£$€]?\d+(?:\.\d+)?\)?$/;
const DASH = /^[-−–—]$/;

function balanced(t: string): boolean {
  return t.startsWith("(") === t.endsWith(")");
}

// An observation split into whitespace tokens, each given its share of the box by characters.
// Vision often returns a label and its note number, or two figures, as one observation.
export function tokensOf(o: OcrObservation): Token[] {
  const [x0, y0, x1, y1] = o.box;
  const text = o.text;
  const per = text.length ? (x1 - x0) / text.length : 0;
  const out: Token[] = [];
  for (const m of text.matchAll(/\S+/g)) {
    const t = m[0];
    const start = m.index!;
    out.push({
      text: t,
      x0: x0 + per * start,
      x1: x0 + per * (start + t.length),
      y0,
      y1,
      figure: FIGURE.test(t) && balanced(t),
      dash: DASH.test(t),
    });
  }
  return out;
}

// Observations grouped into printed rows: two pieces of text are on one row when they overlap
// vertically by at least half the height of the shorter.
export function rowsOf(layer: OcrPageLayer): Row[] {
  const tokens = layer.observations.flatMap(tokensOf).sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2);
  const rows: Row[] = [];
  for (const t of tokens) {
    let best: Row | null = null;
    let bestOverlap = 0;
    for (const r of rows.slice(-4)) {
      const overlap = Math.min(r.y1, t.y1) - Math.max(r.y0, t.y0);
      const need = 0.5 * Math.min(r.y1 - r.y0, t.y1 - t.y0);
      if (overlap >= need && overlap > bestOverlap) {
        best = r;
        bestOverlap = overlap;
      }
    }
    if (best) {
      best.tokens.push(t);
      best.y0 = Math.min(best.y0, t.y0);
      best.y1 = Math.max(best.y1, t.y1);
    } else rows.push({ tokens: [t], y0: t.y0, y1: t.y1 });
  }
  for (const r of rows) r.tokens.sort((a, b) => a.x0 - b.x0);
  return rows.sort((a, b) => a.y0 - b.y0);
}


// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

// "total" is not a distinguishing word: an unlabelled subtotal is named "<section> total", and the
// first read may call it "Current liabilities" or "Current liabilities total".
const STOP = new Set(["and", "the", "of", "in", "on", "at", "for", "to", "a", "an", "or", "by", "from", "note", "notes", "less", "total"]);

// A label as plain lower-case words, "total" kept, for the key and role word tests.
const plain = (t: string) => t.toLowerCase().replace(/[’']/g, "").replace(/[^a-z]+/g, " ").trim();

export function labelWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[’']/g, "")
    .split(/[^a-z]+/)
    .filter((w) => w.length >= 2 && !STOP.has(w));
}

// How well a printed row label matches the first read's printed label: the Dice overlap of their
// words, or the share of the row's words the first label contains when the first read added words
// of its own ("Current liabilities total" for a row printed "Current liabilities").
export function labelScore(rowLabel: string, firstLabel: string): number {
  const a = new Set(labelWords(rowLabel));
  const b = new Set(labelWords(firstLabel));
  if (a.size === 0 || b.size === 0) return 0;
  // "Net current liabilities" is not "Current liabilities", nor "Non-current" "current".
  for (const w of DECISIVE) if (a.has(w) !== b.has(w)) return 0;
  let both = 0;
  for (const w of a) if (b.has(w)) both++;
  const dice = (2 * both) / (a.size + b.size);
  const contained = a.size >= 2 ? both / a.size : 0;
  return Math.max(dice, contained * 0.9);
}

const LABEL_MATCH = 0.7;
const DECISIVE = ["net", "non", "before", "after", "gross"];

// The printed words that can name each key. A row found by the first read's label must also say,
// in its own printed words, what the key means, so a line put under the wrong key abstains.
export const KEY_WORDS: Record<BaseLineKey, RegExp> = {
  turnover: /\b(turnover|revenue|sales)\b/,
  operating_profit: /\boperating\s+(profit|loss|result)|\b(profit|loss)\s+from\s+operations\b/,
  depreciation_amortisation: /\b(depreciation|amortisation|amortization)\b/,
  interest_payable: /\b(interest|finance\s+(costs?|expenses?|charges?))\b/,
  profit_before_tax: /\b(profit|loss)\b.*\bbefore\s+tax/,
  cash_at_bank: /\bcash\b/,
  borrowings_within_one_year: /\b(borrowings?|loans?|notes|bonds?|overdrafts?|facility|facilities|debt|within one year)\b/,
  borrowings_after_one_year: /\b(borrowings?|loans?|notes|bonds?|overdrafts?|facility|facilities|debt)\b/,
  lease_liabilities_total: /\bleases?\b/,
  lease_liabilities_current: /\bleases?\b/,
  lease_liabilities_non_current: /\bleases?\b/,
  preference_shares: /\bpreference\b/,
  shareholder_loans: /\b(loans?|shareholders?|group undertakings|parent|related part)/,
  net_assets: /\bnet\s+(assets|liabilities)\b|\btotal\s+(equity|shareholders)/,
  total_assets: /\btotal\s+assets\b/,
  current_liabilities: /\bcurrent\s+liabilities\b|\bcreditors\b.*\bwithin\s+one\s+year\b/,
  net_current_liabilities: /\bnet\s+current\s+(assets|liabilities)\b/,
};

// Where a label repeats on one statement (Tesco prints "Borrowings" under current and under
// non-current liabilities), the section heading above it decides.
const KEY_SECTION: Partial<Record<BaseLineKey, { want: RegExp; not?: RegExp }>> = {
  borrowings_within_one_year: { want: /current liabilities|within one year/, not: /non[\s-]?current|after (more than )?one year/ },
  borrowings_after_one_year: { want: /non[\s-]?current|after (more than )?one year/ },
  // WP-BE23: three lease keys, each held to its own section. Before, one key accepted a
  // non-current or a total section, which is the ambiguity the split retires.
  lease_liabilities_current: { want: /current liabilities|within one year/, not: /non[\s-]?current|after (more than )?one year/ },
  lease_liabilities_non_current: { want: /non[\s-]?current|after (more than )?one year/ },
  // A total sits under no current or non-current heading, and never under a maturity band.
  lease_liabilities_total: { want: /total/, not: /\bcurrent\b|within one year|after (more than )?one year/ },
};

// The printed tie totals, by the words that head their rows.
const ROLE_WORDS: Record<TieRole, RegExp> = {
  total_equity: /^(total\s+(shareholders\s+)?equity|(total\s+)?shareholders\s+funds|total\s+(shareholders\s+)?(deficit|funds))\b/,
  total_liabilities: /^total\s+liabilities$/,
  current_assets: /^(total\s+)?current\s+assets$/,
  borrowings_total: /^(total\s+)?(borrowings|loans\s+and\s+borrowings|bank\s+loans)$/,
  net_debt: /^(total\s+)?net\s+(debt|funds|cash)$/,
};


// A row as printed can hold more than one line: a balance sheet printed as two panels side by side
// puts "Goodwill 5,092 5,087" and "Trade and other payables 20 (42) (40)" on one row. So a row is
// read as segments, each a label followed by its figures; words after figures start a new segment.
export interface Segment {
  row: number;
  label: Token[];
  figures: Token[]; // figures, nils and note numbers, left to right
  x0: number; // where the segment starts: its label, or its first figure when it has no label
}

const IGNORABLE = /^[|¦!:;.,_'"`~]+$/;
// A figure OCR half-read ("1,141,85€ł"): digits with a little junk after. It stays in the figure
// run, so its line keeps its label, and reading it gives "unreadable", never a value.
const GARBLED = /^\(?[-−–]?\d[\d,.]+[^\s\d]{1,3}$/;
const NOTE_REFS = /^\d{1,2}(?:,\s?\d{1,2})+$/; // "5,28": two note references
// A bare one- or two-digit number is a note reference; bracketed, or with a decimal point, it is an amount.
const isAmount = (t: Token) => t.figure && !/^\d{1,2}$/.test(t.text);

export function segmentsOf(row: Row, index: number): Segment[] {
  const out: Segment[] = [];
  let cur: Segment | null = null;
  const tokens = row.tokens.filter((t) => !IGNORABLE.test(t.text));
  tokens.forEach((t, k) => {
    const next = tokens[k + 1];
    // A dash inside a label ("Exceptional items - finance costs") is punctuation, not a nil.
    const dashInLabel = t.dash && !!next && !(next.figure || next.dash) && /[a-z]/i.test(next.text);
    const numeric = ((t.figure || t.dash) && !dashInLabel) || NOTE_REFS.test(t.text) || GARBLED.test(t.text);
    const prev = tokens[k - 1];
    // Two labels on one printed row, far apart, are two lines (side-by-side panels).
    const farFromLabel = !numeric && !!cur && cur.figures.length === 0 && cur.label.length > 0 && !!prev && t.x0 - prev.x1 > 0.1;
    if (!cur || (!numeric && cur.figures.length > 0) || farFromLabel) {
      cur = { row: index, label: [], figures: [], x0: t.x0 };
      out.push(cur);
    }
    (numeric ? cur.figures : cur.label).push(t);
  });
  return out;
}

const labelText = (s: Segment) => s.label.map((t) => t.text).join(" ");
const hasAmounts = (s: Segment) => s.figures.some((t) => isAmount(t) || GARBLED.test(t.text));

interface PageContext {
  rows: Row[];
  segments: Segment[][]; // by row
  title: string; // the top of the page: company, statement or note title
}

export function pageContext(layer: OcrPageLayer): PageContext {
  const rows = rowsOf(layer);
  const title = rows
    .filter((r) => r.y1 < 0.16)
    .map((r) => r.tokens.map((t) => t.text).join(" "))
    .join(" / ");
  return { rows, segments: rows.map(segmentsOf), title };
}

// The nearest segment above that prints no amount and starts where `x0` says: a section heading
// ("Current liabilities") or the first half of a wrapped label.
function headingAbove(ctx: PageContext, seg: Segment, within: number): Segment | null {
  for (let i = seg.row - 1; i >= 0 && i >= seg.row - 30; i--) {
    const hit = seg.label.length
      ? ctx.segments[i].find((s) => !hasAmounts(s) && s.label.length && Math.abs(s.x0 - seg.x0) <= within)
      : // an unlabelled subtotal: the nearest label-only segment to its left, in its own panel
        ctx.segments[i]
          .filter((s) => !hasAmounts(s) && s.label.length && s.x0 < seg.x0)
          .sort((a, b) => b.x0 - a.x0)[0];
    if (hit) return hit;
  }
  return null;
}

// The label printed for a segment, with a wrapped half on the row above or below ("Trade and other
// payables falling due within" over "one year"), and, for an unlabelled subtotal, the section it
// closes ("Current liabilities total").
function segmentLabel(ctx: PageContext, seg: Segment): string {
  if (!seg.label.length) {
    const section = headingAbove(ctx, seg, 0);
    return section ? `${labelText(section)} total` : "";
  }
  let label = labelText(seg);
  const height = ctx.rows[seg.row].y1 - ctx.rows[seg.row].y0;
  const prev = ctx.segments[seg.row - 1]?.find((s) => !hasAmounts(s) && s.label.length && Math.abs(s.x0 - seg.x0) < 0.02);
  if (prev && ctx.rows[seg.row].y0 - ctx.rows[seg.row - 1].y1 < height * 0.8 && /^[a-z(]/.test(seg.label[0].text)) label = `${labelText(prev)} ${label}`;
  const next = ctx.segments[seg.row + 1]?.find((s) => !hasAmounts(s) && s.label.length && Math.abs(s.x0 - seg.x0) < 0.03);
  if (next && ctx.rows[seg.row + 1].y0 - ctx.rows[seg.row].y1 < height * 0.8 && /^[a-z]/.test(next.label[0].text)) label = `${label} ${labelText(next)}`;
  return label.trim();
}

function sectionText(ctx: PageContext, seg: Segment): string {
  const s = headingAbove(ctx, seg, 0.05);
  return s ? labelText(s).toLowerCase() : "";
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

export interface Column {
  heading: Token; // the printed heading that supports the period
  sub: Token | null; // the sub-column read under a spanning heading ("Total"), when there is one
  x0: number;
  x1: number;
}

const overlaps = (a: { x0: number; x1: number }, b: { x0: number; x1: number }) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0;
const rightAligned = (a: { x1: number }, b: { x1: number }) => Math.abs(a.x1 - b.x1) <= 0.02;
const under = (cell: { x0: number; x1: number }, col: { x0: number; x1: number }) => overlaps(cell, col) || rightAligned(cell, col);
const YEAR_END = /\b(19|20)\d{2}\)?$/;

// Headings are printed as one phrase ("29 December 2024"), so a row's tokens are joined back into
// phrases by the gaps between them. A phrase ends after a year, so two dates printed close together
// ("28 February 2026  22 February 2025") stay two headings.
function phrases(r: Row): Token[] {
  const out: Token[] = [];
  for (const t of r.tokens) {
    if (IGNORABLE.test(t.text)) continue;
    const last = out[out.length - 1];
    if (last && t.x0 - last.x1 < 0.012 && !YEAR_END.test(last.text)) out[out.length - 1] = { ...last, text: `${last.text} ${t.text}`, x1: t.x1, y1: Math.max(last.y1, t.y1) };
    else out.push({ ...t });
  }
  return out;
}

const isYearHeading = (p: Token) => p.text.length <= 40 && /\b(19|20)\d{2}\b/.test(p.text) && p.x0 > 0.25;
const isCaption = (text: string) => {
  const bare = text.replace(/\b(19|20)\d{2}\b/g, "").trim();
  return !!bare && bare.length <= 20 && /[£$€]|000|\bm\b|million|thousand/i.test(bare) && scaleFromCaption(bare) !== null && !/\d{1,3},\d{3}/.test(bare);
};

interface HeadingRow {
  index: number;
  current: Token[]; // headings that print this period
  all: Token[]; // every year heading on the row, this period's and the comparatives'
}

// The nearest row above the segment whose headings print the period over one of its figures. Only
// headings right of the label area count, and a row whose period headings sit over another panel
// is passed over, so the search can climb above a side-by-side panel's own headings.
function headingRowFor(ctx: PageContext, seg: Segment, periodEnd: string): HeadingRow | null {
  for (let i = seg.row - 1; i >= 0; i--) {
    const all = phrases(ctx.rows[i]).filter(isYearHeading);
    const current = all.filter((p) => periodFromHeadings(p.text, [], periodEnd).ok);
    if (current.some((h) => seg.figures.some((f) => under(f, h) || (h.x0 <= f.x0 + 0.08 && h.x1 >= f.x0)))) return { index: i, current, all };
  }
  return null;
}

// Under a heading that spans sub-columns ("2024" over "Underlying | Non-underlying | Total"), the
// line is read from the sub-column headed "Total". A spanning heading with sub-columns and no Total
// is ambiguous, and the line abstains rather than pick one.
function columnFor(ctx: PageContext, hr: HeadingRow, h: Token, firstFigureRow: number): Column | { ambiguous: string } {
  const sorted = [...hr.all].sort((a, b) => a.x0 - b.x0);
  const i = sorted.indexOf(h);
  const mid = (a: Token, b: Token) => ((a.x0 + a.x1) / 2 + (b.x0 + b.x1) / 2) / 2;
  const left = i > 0 ? mid(sorted[i - 1], h) : 0.3;
  const right = i < sorted.length - 1 ? mid(h, sorted[i + 1]) : 1;
  const subs: Token[] = [];
  for (let r = hr.index + 1; r < firstFigureRow && r <= hr.index + 4; r++) {
    for (const p of phrases(ctx.rows[r])) {
      const cx = (p.x0 + p.x1) / 2;
      if (cx < left || cx > right || isCaption(p.text) || /^notes?$/i.test(p.text) || !/[a-z]{2,}/i.test(p.text)) continue;
      const same = subs.find((s) => overlaps(s, p));
      if (same) Object.assign(same, { text: `${same.text} ${p.text}`, x0: Math.min(same.x0, p.x0), x1: Math.max(same.x1, p.x1) });
      else subs.push({ ...p });
    }
  }
  if (subs.length < 2) return { heading: h, sub: null, x0: h.x0, x1: h.x1 };
  const total = subs.filter((s) => /\btotal\b/i.test(s.text));
  if (total.length !== 1) {
    return { ambiguous: `the heading "${h.text}" spans ${subs.length} columns (${subs.map((s) => `"${s.text}"`).join(", ")}) and none is the total` };
  }
  return { heading: h, sub: total[0], x0: total[0].x0, x1: total[0].x1 };
}

// ---------------------------------------------------------------------------
// One line
// ---------------------------------------------------------------------------

export type OcrLineRead =
  | { ok: true; wire: SecondWireLine; row: string; cell: string }
  | { ok: false; code: OcrAbstainCode; detail: string };

// The unit caption for a column: the nearest caption above the segment, in the header rows of its
// table (from two rows above the period heading down to the segment), over the column if one is
// printed there, else anywhere across the table's header.
function captionFor(ctx: PageContext, seg: Segment, hr: HeadingRow, col: Column): string {
  let anywhere = "";
  for (let i = seg.row - 1; i >= Math.max(0, hr.index - 2); i--) {
    if (i < hr.index + 4 || i === hr.index) {
      for (const p of phrases(ctx.rows[i])) {
        if (!isCaption(p.text)) continue;
        const bare = p.text.replace(/\b(19|20)\d{2}\b/g, "").trim();
        if (under(p, col) || under(p, col.heading)) return bare;
        if (!anywhere && p.x0 > 0.25) anywhere = bare;
      }
    }
  }
  return anywhere;
}

type CellRead =
  | { ok: true; col: Column; cell: Token; caption: string; hr: HeadingRow }
  | { ok: false; code: OcrAbstainCode; detail: string };

function readCell(ctx: PageContext, seg: Segment, periodEnd: string): CellRead {
  const hr = headingRowFor(ctx, seg, periodEnd);
  if (!hr) return { ok: false, code: OCR_ABSTAIN.noColumn, detail: `no column heading above it prints the period ending ${periodEnd}` };
  let firstFigureRow = seg.row;
  for (let r = hr.index + 1; r < seg.row; r++) if (ctx.segments[r].some(hasAmounts)) {
    firstFigureRow = r;
    break;
  }
  const cols: Column[] = [];
  for (const h of hr.current) {
    const c = columnFor(ctx, hr, h, firstFigureRow);
    if ("ambiguous" in c) {
      if (seg.figures.some((f) => under(f, h) || (h.x0 <= f.x0 + 0.08 && h.x1 >= f.x0))) return { ok: false, code: OCR_ABSTAIN.ambiguousColumn, detail: c.ambiguous };
      continue;
    }
    cols.push(c);
  }
  let hits = cols.map((col) => ({ col, cells: seg.figures.filter((t) => under(t, col)) })).filter((h) => h.cells.length);
  if (!hits.length) {
    const h = hr.current[0];
    return { ok: false, code: OCR_ABSTAIN.emptyCell, detail: `nothing is printed in the column headed "${h.text}"` };
  }
  if (hits.length > 1) {
    // Group and company columns for the same year: take the one headed "Group" or "Consolidated".
    const group = hits.filter((h) => spanningAbove(ctx, hr, h.col).some((t) => headingBasis(t) === "group"));
    if (group.length !== 1) {
      return {
        ok: false,
        code: OCR_ABSTAIN.ambiguousColumn,
        detail: `${hits.length} columns print the period (${hits.map((h) => `"${h.col.heading.text}"`).join(", ")}), and nothing printed says which one the line is read from`,
      };
    }
    hits = group;
  }
  const { col, cells } = hits[0];
  // Figures right-align under their heading, so the cell is the right-most text under it.
  const cell = cells.reduce((a, b) => (b.x1 > a.x1 ? b : a));
  const where = `the column headed "${col.heading.text}"${col.sub ? `, "${col.sub.text}"` : ""}`;
  if (cell.dash) return { ok: false, code: OCR_ABSTAIN.emptyCell, detail: `${where} prints "${cell.text}" (nil)` };
  if (!cell.figure || !readPrintedFigure(cell.text)) return { ok: false, code: OCR_ABSTAIN.unreadable, detail: `OCR read "${cell.text}" in ${where}, which is not a figure` };
  return { ok: true, col, cell, caption: captionFor(ctx, seg, hr, col), hr };
}

// Text printed over the column above the period heading, within the table: "Group" or "Company"
// spanning a pair of year columns.
function spanningAbove(ctx: PageContext, hr: HeadingRow, col: Column): string[] {
  const out: string[] = [];
  for (let j = hr.index - 1; j >= 0 && j >= hr.index - 2; j--) {
    for (const p of phrases(ctx.rows[j])) if (p.x0 > 0.25 && under(p, col.heading) && /[a-z]/i.test(p.text) && !isYearHeading(p)) out.push(p.text);
  }
  return out;
}

function basisOf(title: string, heading: string, spanning: string[]): { basis: SecondWireLine["basis"]; text: string } {
  const texts = [heading, ...spanning, title];
  const company = texts.find((t) => headingBasis(t) === "company");
  if (company) return { basis: "company", text: company };
  const group = texts.find((t) => headingBasis(t) === "group");
  if (group) return { basis: "consolidated", text: group };
  return { basis: "none", text: "" };
}

interface Placed {
  seg: Segment;
  label: string;
}

// The segments whose printed label best matches, among those that print an amount.
function placeSegments(ctx: PageContext, key: BaseLineKey | null, match: (label: string) => number, firstLabel = ""): Placed[] {
  const scored: (Placed & { score: number })[] = [];
  for (const segs of ctx.segments) {
    for (const seg of segs) {
      if (!hasAmounts(seg)) continue;
      const label = segmentLabel(ctx, seg);
      const score = match(label);
      if (score >= LABEL_MATCH) scored.push({ seg, label, score });
    }
  }
  const section = key ? KEY_SECTION[key] : undefined;
  // A line under a section that says it is the other key ("Non-current liabilities" for a
  // borrowing due within one year) is never this key's line.
  const allowed = section?.not ? scored.filter((s) => !section.not!.test(sectionText(ctx, s.seg))) : scored;
  if (!allowed.length) return [];
  const top = Math.max(...allowed.map((s) => s.score));
  let best = allowed.filter((s) => s.score >= top - 1e-9);
  if (best.length > 1 && section) {
    const inSection = best.filter((b) => section.want.test(sectionText(ctx, b.seg)));
    if (inSection.length) best = inSection;
  }
  // Still tied: the table heading above each line, scored against the first read's label
  // ("Bond notes and other borrowings: Within one year" against two "Within one year" rows).
  if (best.length > 1 && firstLabel) {
    const withSection = best.map((b) => ({ b, s: labelScore(`${sectionText(ctx, b.seg)} ${b.label}`, firstLabel) }));
    const max = Math.max(...withSection.map((w) => w.s));
    const winners = withSection.filter((w) => w.s >= max - 1e-9);
    if (winners.length === 1) best = [winners[0].b];
  }
  return best;
}

export function readLineFromOcr(key: BaseLineKey, first: FoundLine, layer: OcrPageLayer, excerptPage: number, ctx = pageContext(layer)): OcrLineRead {
  const firstLabel = first.printedLabel ?? "";
  const placed = placeSegments(ctx, key, (l) => labelScore(l, firstLabel), firstLabel);
  if (!placed.length) return { ok: false, code: OCR_ABSTAIN.noLabel, detail: `no line on page ${first.pdfPageIndex} prints the label "${firstLabel}"` };
  // Lines that tie on the label must all give the same figure, or none is taken.
  const reads = placed.map((p) => ({ p, cell: readCell(ctx, p.seg, first.periodEnd) }));
  const good = reads.filter((r): r is { p: Placed; cell: Extract<CellRead, { ok: true }> } => r.cell.ok);
  if (!good.length) {
    const r = reads[0].cell as Extract<CellRead, { ok: false }>;
    return { ok: false, code: r.code, detail: `line "${reads[0].p.label}": ${r.detail}` };
  }
  if (new Set(good.map((g) => g.cell.cell.text)).size > 1) {
    return {
      ok: false,
      code: OCR_ABSTAIN.ambiguousLabel,
      detail: `${good.length} lines print the label (${good.map((g) => `"${g.p.label}" ${g.cell.cell.text}`).join(", ")}), and nothing printed says which one is meant`,
    };
  }
  const { p, cell: c } = good[0];
  if (!KEY_WORDS[key].test(plain(p.label)) && !KEY_WORDS[key].test(plain(sectionText(ctx, p.seg)))) {
    return { ok: false, code: OCR_ABSTAIN.labelNotKey, detail: `the line is printed "${p.label}", which does not name ${key.replace(/_/g, " ")}` };
  }
  const spanning = spanningAbove(ctx, c.hr, c.col);
  const basis = basisOf(ctx.title, c.col.heading.text, spanning);
  const printed = readPrintedFigure(c.cell.text)!;
  return {
    ok: true,
    row: p.label,
    cell: c.cell.text,
    wire: {
      key,
      status: "found",
      abstain_reason: "",
      printed_label: p.label,
      figure_text: c.cell.text,
      sign: printed.negative ? "negative" : "positive",
      scale_caption: c.caption,
      header_scale_caption: c.caption,
      header_currency: "",
      column_heading: c.col.heading.text,
      header_rows_above: spanning.slice(0, 2),
      period_end: first.periodEnd,
      excerpt_page: excerptPage,
      statement: ctx.title,
      basis: basis.basis,
      basis_text: basis.text,
    },
  };
}

function readTieFromOcr(role: TieRole, periodEnd: string, ctxs: { ctx: PageContext; excerptPage: number }[]): SecondWireTieLine {
  const abstain: SecondWireTieLine = {
    role,
    status: "abstain",
    abstain_reason: "not-printed",
    printed_label: "",
    figure_text: "",
    sign: "none",
    scale_caption: "",
    column_heading: "",
    period_end: "",
    excerpt_page: 0,
  };
  const words = ROLE_WORDS[role];
  const found: SecondWireTieLine[] = [];
  for (const { ctx, excerptPage } of ctxs) {
    for (const p of placeSegments(ctx, null, (l) => (words.test(plain(l)) ? 1 : 0))) {
      const c = readCell(ctx, p.seg, periodEnd);
      if (!c.ok) continue;
      const printed = readPrintedFigure(c.cell.text)!;
      found.push({
        role,
        status: "found",
        abstain_reason: "",
        printed_label: p.label,
        figure_text: c.cell.text,
        sign: printed.negative ? "negative" : "positive",
        scale_caption: c.caption,
        column_heading: c.col.heading.text,
        period_end: periodEnd,
        excerpt_page: excerptPage,
      });
    }
  }
  // A total printed twice with two values is not a total this reader can pick.
  if (!found.length || new Set(found.map((f) => f.figure_text)).size > 1) return abstain;
  return found[0];
}

// ---------------------------------------------------------------------------
// The whole read
// ---------------------------------------------------------------------------

export interface OcrLineDiagnostic {
  key: BaseLineKey;
  page: number;
  first: string; // the first read's figure as printed
  ocr: string | null; // what OCR read in the cell, or null when it could not place one
  code: OcrAbstainCode | null; // why it could not, when it could not
  detail: string;
}

export interface OcrSecondRead {
  wire: SecondReadWire;
  pages: number[];
  diagnostics: OcrLineDiagnostic[];
}

// Build the second read of every found line from the OCR layers of the cited pages. `layers` maps
// a PDF page index to its layer, or to the reason there is none.
export function ocrSecondRead(first: VisionReadResult, layers: Map<number, OcrPageLayer | string>): OcrSecondRead {
  const found = BASE_LINE_KEYS.filter((k) => first.lines[k].status === "found");
  const pages = [...new Set(found.map((k) => (first.lines[k] as FoundLine).pdfPageIndex))].sort((a, b) => a - b);
  const ctxByPage = new Map<number, PageContext>();
  for (const p of pages) {
    const l = layers.get(p);
    if (l && typeof l !== "string") ctxByPage.set(p, pageContext(l));
  }
  const lines: SecondWireLine[] = [];
  const diagnostics: OcrLineDiagnostic[] = [];
  for (const key of found) {
    const line = first.lines[key] as FoundLine;
    const excerptPage = pages.indexOf(line.pdfPageIndex) + 1;
    const layer = layers.get(line.pdfPageIndex);
    const ctx = ctxByPage.get(line.pdfPageIndex);
    const r: OcrLineRead =
      layer && typeof layer !== "string" && ctx
        ? readLineFromOcr(key, line, layer, excerptPage, ctx)
        : { ok: false, code: OCR_ABSTAIN.noLayer, detail: typeof layer === "string" ? layer : `no OCR layer for page ${line.pdfPageIndex}` };
    if (r.ok) {
      lines.push(r.wire);
      diagnostics.push({ key, page: line.pdfPageIndex, first: line.figureText, ocr: r.cell, code: null, detail: `row "${r.row}", column "${r.wire.column_heading}", caption "${r.wire.scale_caption}"` });
    } else {
      lines.push(abstainLine(key, `${r.code}: ${r.detail}`));
      diagnostics.push({ key, page: line.pdfPageIndex, first: line.figureText, ocr: null, code: r.code, detail: r.detail });
    }
  }
  const periodEnd = first.document.periodEnd ?? (found.length ? (first.lines[found[0]] as FoundLine).periodEnd : "");
  const ctxs = pages.filter((p) => ctxByPage.has(p)).map((p) => ({ ctx: ctxByPage.get(p)!, excerptPage: pages.indexOf(p) + 1 }));
  const tie_lines = TIE_ROLES.map((role) => readTieFromOcr(role, periodEnd, ctxs));
  return { wire: { lines, tie_lines }, pages, diagnostics };
}

function abstainLine(key: BaseLineKey, reason: string): SecondWireLine {
  return {
    key,
    status: "abstain",
    abstain_reason: reason,
    printed_label: "",
    figure_text: "",
    sign: "none",
    scale_caption: "",
    header_scale_caption: "",
    header_currency: "",
    column_heading: "",
    header_rows_above: [],
    period_end: "",
    excerpt_page: 0,
    statement: "",
    basis: "none",
    basis_text: "",
  };
}
