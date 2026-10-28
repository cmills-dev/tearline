// lib/vision/verify.ts
// Verification of figures read from a scan (WP-BE05), and the function that applies it to a read.
//
// The interface and its contract live in ./types.ts. The verifier here is the one the live path
// runs. It exists because a vision model reading a scanned page can be confidently wrong, and a
// scan has no text layer to check a figure against. So a figure surfaces only when:
//
//   1. a second, independent read agrees with it. The second read is sent ONLY the pages the
//      first read cited, cut out as a new PDF, and is told only which lines to look for. It
//      never sees the first read's figures, labels, scales or periods. Agreement is on the
//      value, the sign, the scale and the period, not on the wording.
//   2. its scale matches the unit caption printed at the head of the statement it sits in, and
//      that caption establishes the currency as pounds. A page that prints no caption abstains,
//      even when the digits are right, because that is how GBP 41,000 becomes GBP 41m.
//   3. its period matches the column heading it was read from and the period the accounts are
//      made up to, so a comparative column cannot pass for the current year.
//   4. when the resolver says the filing is group accounts, it sits in the group's statements, not
//      the parent company's own (WP-BE18, see "The basis check" below).
//   5. no printed arithmetic tie it takes part in fails. Where both sides of the balance sheet
//      tie or the net debt tie are printed, the tie runs. A tie that fails abstains the figures
//      in it and says by how much. A tie that cannot run is recorded as not run.
//
// Everything else abstains, with a reason written for the person reading the sheet. There is no
// flag that lets a single read through: lib/sources/visionAccounts.ts re-checks the evidence
// before landing a figure, and lib/engine checks the provenance tag again after that.

import { getCache, type Cache } from "../cache/cache";
import { getAnthropicProvider } from "../llm/config";
import { cacheModelFor } from "./cache";
import type { LLMEffort, LLMUsage, StructuredLLMProvider } from "../llm/types";
import { scaleFromCaption, toPence } from "./scale";
import { cutPdfPages } from "./pages";
import {
  SECOND_READ_PROMPT_VERSION,
  SECOND_READ_SCHEMA,
  SECOND_READ_SCHEMA_VERSION,
  SECOND_READ_SYSTEM_PROMPT,
  parseSecondRead,
  secondReadPromptHash,
  secondReadUserText,
  secondReadValue,
  type SecondReadWire,
  type SecondWireLine,
  type TieRole,
} from "./secondRead";
import type { AccountsTypeLabel } from "../resolve/accountsType";
import { BASIS_ABSTAIN, headingBasis, printsGroupStatement } from "./basisWords";
import { OcrSecondReadVerifier, type OcrVerifierDeps } from "./ocrVerify";
import { HybridSecondReadVerifier } from "./hybridVerify";
import {
  BASE_LINE_KEYS,
  type AbstainLine,
  type BasisEvidence,
  type BaseLineKey,
  type DoubleReadEvidence,
  type FoundLine,
  type PeriodSource,
  type SecondReadFigure,
  type TieResult,
  type VerifiedLine,
  type VisionLine,
  type VisionReadResult,
  type VisionVerifier,
  type VisionVerifyInput,
  type VisionVerifyResult,
} from "./types";

export const PASS_THROUGH_VERIFIER_NAME = "pass-through/v1";
export const DOUBLE_READ_VERIFIER_NAME = `double-read/${SECOND_READ_PROMPT_VERSION}`;
export const SECOND_READ_MAX_TOKENS = 8_000;
// "medium", not Opus 5's default "high" (WP-BE18). On 22 Sep 2026 the second read of James Fisher
// spent 1,600 of 4,270 output tokens thinking and took 39 s. A second read that thinks less can
// fail to agree, which abstains a figure; it cannot supply one. It is in the cache key.
export const SECOND_READ_EFFORT: LLMEffort = "medium";
const SECOND_READ_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;

function everyLine(tag: VerifiedLine): Record<BaseLineKey, VerifiedLine> {
  return Object.fromEntries(BASE_LINE_KEYS.map((k) => [k, { ...tag }])) as Record<BaseLineKey, VerifiedLine>;
}

// Checks nothing, claims nothing, costs nothing. Since WP-BE05 a line it leaves "unverified" does
// not surface, so a run with this verifier shows every scanned figure as an abstention that says
// no second read was made.
export const passThroughVerifier: VisionVerifier = {
  name: PASS_THROUGH_VERIFIER_NAME,
  async verify(_input: VisionVerifyInput): Promise<VisionVerifyResult> {
    return {
      verifier: PASS_THROUGH_VERIFIER_NAME,
      lines: everyLine({ tag: "unverified", note: "No second read was made of this page." }),
      overrides: {},
      usage: null,
    };
  },
};

// ---------------------------------------------------------------------------
// Words for the reader
// ---------------------------------------------------------------------------

export function pounds(n: number): string {
  const abs = Math.abs(n).toLocaleString("en-GB", { maximumFractionDigits: 2 });
  return `${n < 0 ? "-" : ""}£${abs}`;
}

const SINGLE_READ = "A figure seen by one read only is never shown.";

function pageList(pages: number[]): string {
  return pages.length === 1 ? `page ${pages[0]}` : `pages ${pages.join(", ")}`;
}

// ---------------------------------------------------------------------------
// Scale, currency and period
// ---------------------------------------------------------------------------

// The currency a caption or heading states, as an ISO code, or null when it states none.
export function currencyFromText(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.toLowerCase();
  if (/us\$|usd|\$|dollar/.test(t)) return "USD";
  if (/€|eur\b|euro/.test(t)) return "EUR";
  if (/£|gbp|sterling|pound/.test(t)) return "GBP";
  return null;
}

// The number of decimal places printed, so a rounding tolerance matches the printed precision.
function printedDecimals(figureText: string): number {
  const m = figureText.match(/\d[\d,]*\.(\d+)/);
  return m ? m[1].length : 0;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

// Every full date printed in a heading, in the order printed.
//
// DECISION (WP-BE22): a numeric date is read DAY FIRST, always. These are UK filings, and UK
// accounts print "28/9/25" for 28 September 2025. A two-digit year forces the choice, because
// "5/4/25" is 5 April under the UK reading and 4 May under the US one. The rule is not decided
// per heading, and it is never flipped to make a heading match: a date that is ambiguous is read
// day first and then has to equal the period end the reads give, and those have to equal the
// date the accounts are made up to (judgeLine). A month-first reading that would match is not
// accepted; the line abstains and the reason says what the day-first reading was. A numeric date
// that is impossible day first ("9/28/25") is not a date at all, and the heading abstains.
//
// A two-digit year is 20yy. A comparative from the 1990s read as 2099 fails the period check and
// abstains, which is the same outcome it would have had read correctly.
//
// RS-06 finding 6 keeps that decision and closes the ways a US-style date could still be misread
// without anyone being told:
//   - A date with the month in words is not ambiguous in either order, so "December 31, 2025"
//     and "Sept. 30, 2025" are read as the dates they are. They used to match no pattern, so the
//     heading was judged on its year alone, and a column headed with a different date in the same
//     year passed. ISO dates ("2025-12-31") had the same hole and are read too.
//   - A numeric date that is a date only month first ("12/31/2025", "9/28/25") is US-style. It is
//     reported as such, not read, and the heading abstains saying what it would have been.
//   - A numeric date that reads both ways ("5/4/25") is read day first and carries the month-first
//     reading beside it. If only the month-first reading equals the period end, the line abstains
//     and says exactly that, rather than a bare "did not match".
// There is no standard date parser to reach for: Intl.DateTimeFormat formats and does not parse,
// and Temporal is not in Node 24.
export type HeadingDate = { iso: string; printed: string; index: number; end: number; monthFirst?: string };

function isoDate(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1) return null;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > days) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

const MONTH_WORD = "(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?";

export function headingDates(heading: string): { dates: HeadingDate[]; unreadable: string[]; monthFirstOnly: string[] } {
  const t = heading.toLowerCase();
  const dates: HeadingDate[] = [];
  const unreadable: string[] = [];
  const monthFirstOnly: string[] = [];
  const add = (m: RegExpMatchArray, iso: string | null, monthFirst?: string) => {
    const printed = heading.slice(m.index!, m.index! + m[0].length);
    if (iso) dates.push({ iso, printed, index: m.index!, end: m.index! + m[0].length, ...(monthFirst ? { monthFirst } : {}) });
    else unreadable.push(printed);
  };
  // "31 December 2025", "31st Dec. 2025".
  for (const m of t.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_WORD},?\\s+((?:19|20)\\d{2})\\b`, "g"))) {
    add(m, isoDate(Number(m[3]), MONTHS[m[2]], Number(m[1])));
  }
  // "December 31, 2025", "Sept. 30 2025": the month in words, so no convention is needed.
  for (const m of t.matchAll(new RegExp(`\\b${MONTH_WORD}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+((?:19|20)\\d{2})\\b`, "g"))) {
    add(m, isoDate(Number(m[3]), MONTHS[m[1]], Number(m[2])));
  }
  // "2025-12-31", "2025/12/31": year first is always year, month, day.
  for (const m of t.matchAll(/\b((?:19|20)\d{2})([./-])(\d{1,2})\2(\d{1,2})\b/g)) {
    add(m, isoDate(Number(m[1]), Number(m[3]), Number(m[4])));
  }
  // Numeric: d/m/yy, d.m.yy, d-m-yy and the four-digit forms, one separator throughout.
  for (const m of t.matchAll(/\b(\d{1,2})([./-])(\d{1,2})\2(\d{4}|\d{2})\b/g)) {
    const year = m[4].length === 2 ? 2000 + Number(m[4]) : Number(m[4]);
    const dayFirst = isoDate(year, Number(m[3]), Number(m[1])); // day first: see DECISION above
    const monthFirst = isoDate(year, Number(m[1]), Number(m[3]));
    if (!dayFirst && monthFirst) {
      monthFirstOnly.push(heading.slice(m.index!, m.index! + m[0].length));
      continue;
    }
    add(m, dayFirst, dayFirst && monthFirst && monthFirst !== dayFirst ? monthFirst : undefined);
  }
  dates.sort((a, b) => a.index - b.index);
  return { dates, unreadable, monthFirstOnly };
}

const longDate = (iso: string): string =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

// The period END a heading prints, or why it cannot be taken from it. One date is the end. Two
// dates are a period only when the words between them say so ("30/9/24 to 28/9/25"), and then
// the later one is the end and it must fall after the start. Anything else is not guessed at.
function headingEnd(heading: string): { iso: string; monthFirst?: string } | { problem: string } | null {
  const { dates, unreadable, monthFirstOnly } = headingDates(heading);
  if (monthFirstOnly.length) {
    const printed = monthFirstOnly[0];
    const [a, b, y] = printed.split(/[./-]/).map(Number);
    const asUs = isoDate(y < 100 ? 2000 + y : y, a, b)!;
    return {
      problem: `The period could not be established: the heading "${heading}" prints "${printed}", which is not a date when read day first, as UK accounts print dates. Read month first, as US accounts print them, it would be ${longDate(asUs)}; a date is not read the other way round to make it fit, so the line abstains.`,
    };
  }
  if (unreadable.length) {
    return { problem: `The period could not be established: the heading "${heading}" prints "${unreadable[0]}", which is not a date when read day first, as UK accounts print dates.` };
  }
  if (dates.length === 0) return null;
  if (dates.length === 1) return { iso: dates[0].iso, ...(dates[0].monthFirst ? { monthFirst: dates[0].monthFirst } : {}) };
  if (dates.length === 2) {
    const between = heading.slice(dates[0].end, dates[1].index);
    if (/^\s*(?:to|until|till|through|-|–|—)\s*$/i.test(between) && dates[0].iso < dates[1].iso) return { iso: dates[1].iso };
  }
  return { problem: `The period could not be established: the heading "${heading}" prints more than one date, and not as one period running from one to the other.` };
}

// How a single piece of heading text bears on the period end: it supports it, it contradicts it,
// or it prints no year at all ("silent").
type HeadingVerdict = { kind: "supports" } | { kind: "contradicts"; reason: string } | { kind: "silent" };

function judgeHeadingText(text: string, periodEnd: string, contradiction: string): HeadingVerdict {
  const end = headingEnd(text);
  if (end && "problem" in end) return { kind: "contradicts", reason: end.problem };
  if (end && end.iso !== periodEnd && end.monthFirst === periodEnd) {
    return {
      kind: "contradicts",
      reason: `${contradiction} Read day first, as UK accounts print dates, "${text}" is ${longDate(end.iso)}. Only a month-first (US) reading, ${longDate(end.monthFirst)}, would match, and a date is not read the other way round to make it fit.`,
    };
  }
  if (end) return end.iso === periodEnd ? { kind: "supports" } : { kind: "contradicts", reason: contradiction };
  const years = [...text.matchAll(/\b((?:19|20)\d{2})\b/g)].map((m) => Number(m[1]));
  if (years.length === 0) return { kind: "silent" };
  const y = Number(periodEnd.slice(0, 4));
  const earlyJanuary = periodEnd.slice(5, 7) === "01" && Number(periodEnd.slice(8, 10)) <= 14;
  return years.includes(y) || (earlyJanuary && years.includes(y - 1)) ? { kind: "supports" } : { kind: "contradicts", reason: contradiction };
}

export type PeriodJudgement = { ok: true; source: PeriodSource } | { ok: false; reason: string };

// The header rows the look-up may read: at most two (WP-BE22), nearest first, blanks dropped.
export const MAX_HEADER_ROWS_ABOVE = 2;

// The period of a figure, from its column heading and, when that heading prints no year, from
// the header rows of the same table above it (WP-BE22). Group accounts often head a table in two
// rows: "2025" spanning "Underlying | Non-underlying | Total", or the period printed at the left
// of the header rows, as Bellis Finco prints "Year ended 31 December 2025" beside "£m" above a
// column headed only "Post non-underlying items".
//
// The rules, none of which lowers the bar a column heading alone has to meet:
//   - a column heading that prints a date or year decides on its own; a row above cannot rescue
//     a column heading that prints the wrong year;
//   - only a column heading that prints no year at all looks up, and it looks at no more than
//     MAX_HEADER_ROWS_ABOVE rows, nearest first. The second read copies them from the same table
//     only (secondRead.ts); the statement's title, another table and another column's heading are
//     never read;
//   - the nearest row that prints a date or year decides, by exactly the test a column heading
//     meets;
//   - no year in the column heading or in any row read: the line abstains, and the reason names
//     every row read.
// The year is never taken from the filing date, the file name or the company's usual year end.
export function periodFromHeadings(heading: string | null, rowsAbove: readonly string[] | null | undefined, periodEnd: string): PeriodJudgement {
  if (!heading || !heading.trim()) {
    return { ok: false, reason: `The period could not be established: no column heading was read for this figure, so it could be this year or last.` };
  }
  const h = heading.trim();
  const column = judgeHeadingText(h, periodEnd, `The period did not match: the figure sits under the column headed "${h}", but the accounts period ends ${periodEnd}.`);
  if (column.kind === "supports") return { ok: true, source: { from: "column-heading", text: h } };
  if (column.kind === "contradicts") return { ok: false, reason: column.reason };

  const rows = (rowsAbove ?? []).map((r) => r.trim()).filter(Boolean).slice(0, MAX_HEADER_ROWS_ABOVE);
  for (const row of rows) {
    const v = judgeHeadingText(
      row,
      periodEnd,
      `The period did not match: the figure sits under the column headed "${h}", and the header row above it in the same table reads "${row}", but the accounts period ends ${periodEnd}.`
    );
    if (v.kind === "supports") return { ok: true, source: { from: "header-row", text: row, columnHeading: h, rowsRead: rows } };
    if (v.kind === "contradicts") return { ok: false, reason: v.reason };
  }
  const read = rows.length
    ? `, and neither do the header rows read above it in the same table (${rows.map((r) => `"${r}"`).join(", ")})`
    : `, and no header row above it in the same table was read`;
  return { ok: false, reason: `The period could not be established: the column heading "${h}" prints no year${read}.` };
}

// Null when the column heading supports the period end; otherwise the reason it does not.
// A heading that prints a full date must print this date. A heading that prints only a year
// must print this period's year, or, for a 52 or 53 week year ending in the first fortnight of
// January, the year before (UK retailers head "1 January 2026" as "2025"). A heading with no
// year or date at all cannot establish the period. The heading alone: see periodFromHeadings
// for the look-up into the header rows above it.
export function periodFromHeading(heading: string | null, periodEnd: string): string | null {
  const j = periodFromHeadings(heading, [], periodEnd);
  if (j.ok) return null;
  // The heading-only form keeps its original words for a heading with no year.
  return j.reason.replace(/, and no header row above it in the same table was read\.$/, ".");
}

// ---------------------------------------------------------------------------
// The judgement on one line
// ---------------------------------------------------------------------------

interface Candidate {
  key: BaseLineKey;
  first: FoundLine;
  second: SecondReadFigure;
  scale: number;
  pounds: number;
  unit: number; // pounds per last printed digit, for rounding tolerance
}

type LineJudgement = { ok: true; candidate: Candidate } | { ok: false; reason: string };

function mapPage(excerptPage: number, pages: number[]): number | null {
  return Number.isInteger(excerptPage) && excerptPage >= 1 && excerptPage <= pages.length ? pages[excerptPage - 1] : null;
}

export function judgeLine(
  key: BaseLineKey,
  first: FoundLine,
  wire: SecondWireLine | undefined,
  pages: number[],
  documentPeriodEnd: string | null
): LineJudgement {
  const where = pageList(pages);
  if (!wire || wire.status === "abstain") {
    const why = wire?.abstain_reason?.trim();
    return {
      ok: false,
      reason: `The second read did not find this line on ${where}${why ? ` (${why})` : ""}. ${SINGLE_READ}`,
    };
  }
  const secondValue = secondReadValue(wire.figure_text, wire.sign);
  const secondPage = mapPage(wire.excerpt_page, pages);
  if (secondValue === null || secondPage === null || !wire.period_end.trim()) {
    return {
      ok: false,
      reason: `The second read of this line was incomplete, so it could not confirm the first. ${SINGLE_READ}`,
    };
  }

  // 1. Agreement on the value and sign. Compared in pounds when both scales are understood, so
  // "12.5" under £m and "12,500" under £'000 would agree; otherwise on the printed value.
  const s1 = scaleFromCaption(first.scaleCaption);
  const s2 = scaleFromCaption(wire.scale_caption);
  const firstPounds = s1 !== null ? toPence(first.value * s1) : null;
  const secondPounds = s2 !== null ? toPence(secondValue * s2) : null;
  const agree = firstPounds !== null && secondPounds !== null ? firstPounds === secondPounds : first.value === secondValue;
  if (!agree) {
    const diff =
      firstPounds !== null && secondPounds !== null
        ? `, which is ${pounds(firstPounds)} against ${pounds(secondPounds)}, a difference of ${pounds(Math.abs(firstPounds - secondPounds))}`
        : "";
    return {
      ok: false,
      reason: `The two reads disagreed: the first read "${first.figureText}" under ${first.scaleCaption} and the second read "${wire.figure_text}" under ${wire.scale_caption || "no caption"}${diff}.`,
    };
  }

  // 2. Scale and currency, established from the statement header, not from the figure's size.
  const header = wire.header_scale_caption.trim();
  if (!header) {
    return {
      ok: false,
      reason: `The scale could not be established from the page: no unit caption is printed at the head of the statement "${first.statement}", so "${first.figureText}" could be pounds, thousands or millions.`,
    };
  }
  const sh = scaleFromCaption(header);
  if (sh === null) {
    return {
      ok: false,
      reason: `The scale could not be established from the page: the statement header prints "${header}", which is not a unit this reader understands.`,
    };
  }
  if (s1 !== sh || s2 !== sh) {
    return {
      ok: false,
      reason: `The scale did not match the statement header: the figure was read under "${first.scaleCaption}", but the head of the statement prints "${header}".`,
    };
  }
  const currency = currencyFromText(header) ?? currencyFromText(wire.header_currency);
  if (currency === null) {
    return {
      ok: false,
      reason: `The currency could not be established from the page: the statement header "${header}" names no currency.`,
    };
  }
  if (currency !== "GBP") {
    return {
      ok: false,
      reason: `The figure is printed in ${currency}, and this sheet is in pounds, so it is not shown.`,
    };
  }

  // 3. Period: both reads, the column heading and the accounts period.
  const p2 = wire.period_end.trim();
  if (p2 !== first.periodEnd) {
    return {
      ok: false,
      reason: `The period did not match: the first read took the column for the period ended ${first.periodEnd}, the second read took ${p2}.`,
    };
  }
  const period = periodFromHeadings(wire.column_heading, wire.header_rows_above, first.periodEnd);
  if (!period.ok) return { ok: false, reason: period.reason };
  if (documentPeriodEnd && documentPeriodEnd !== first.periodEnd) {
    return {
      ok: false,
      reason: `The period did not match: the figure is for the period ended ${first.periodEnd}, but the accounts are made up to ${documentPeriodEnd}.`,
    };
  }

  const second: SecondReadFigure = {
    printedLabel: wire.printed_label.trim() || null,
    figureText: wire.figure_text.trim(),
    value: secondValue,
    scaleCaption: wire.scale_caption.trim(),
    headerScaleCaption: header,
    currency,
    columnHeading: wire.column_heading.trim() || null,
    headerRowsAbove: (wire.header_rows_above ?? []).map((r) => r.trim()).filter(Boolean).slice(0, MAX_HEADER_ROWS_ABOVE),
    periodSource: period.source,
    periodEnd: p2,
    pdfPageIndex: secondPage,
    statement: wire.statement.trim() || null,
  };
  const unit = sh * Math.pow(10, -Math.max(printedDecimals(first.figureText), printedDecimals(second.figureText)));
  return { ok: true, candidate: { key, first, second, scale: sh, pounds: firstPounds!, unit } };
}

// ---------------------------------------------------------------------------
// The basis check (WP-BE18)
// ---------------------------------------------------------------------------
//
// A group filing carries two balance sheets, the group's and the parent company's, and both tie.
// A first read that took the company's, handed only that page, would be agreed by the second read.
// So when the resolver says the filing is group accounts:
//   - the first read's document basis must be "consolidated";
//   - the second read, which is not told the first read's basis, must say "consolidated" for the
//     line itself, having found it on the page;
//   - no printed heading for the line (the first read's cited statement, the second read's
//     statement, the words it gave for the basis, the column heading) may be a company-only
//     heading, such as "Company balance sheet" or a column headed "Company";
//   - at least one of those printed headings must say "consolidated" or "group". A note to the
//     group accounts is headed "18. Borrowings", so its group wording is usually the page title,
//     "Notes to the consolidated financial statements", which the second read copies.
// The check is words on the page, not a model's opinion: a line both reads call consolidated
// still abstains when nothing printed says so. It never applies to a filing that is not group
// accounts, and it can only make a figure abstain.

// The words themselves live in ./basisWords (WP-GRPCHK), shared with the text-layer extractor.
export { BASIS_ABSTAIN, headingBasis, printsGroupStatement, type HeadingBasis } from "./basisWords";

export function isGroupAccounts(accountsType: AccountsTypeLabel | null | undefined): boolean {
  return accountsType === "group";
}

// Who is a group filer (WP-GRPCHK). The register's label is the filer's own choice of form, and
// a parent that prints consolidated statements may lodge them as "full" accounts. Its company
// balance sheet ties as well as the group's, so the basis check must not wait for the word
// "group" on the register. A filing is held to the check when any of these holds:
//   - the register says group accounts;
//   - the first read says it took the consolidated statements;
//   - a statement the first read cited is printed as the group's: "Consolidated balance sheet",
//     "Group income statement", "Notes to the consolidated financial statements".
// Only a statement heading counts. "Amounts owed to group undertakings" is a single company's
// note, and holding a single company to the check would abstain its every figure for want of
// the word "group". Null when the filing is none of these. The string is the start of every
// reason the check gives, so the reason says why the filing was held to it.
export function groupFilerWhy(
  accountsType: AccountsTypeLabel | null | undefined,
  read: Pick<VisionReadResult, "document" | "lines"> | null | undefined
): string | null {
  if (isGroupAccounts(accountsType)) return "the filing is group accounts";
  if (!read) return null;
  const registerWords = accountsType ? `, though the register calls it "${accountsType}" accounts` : "";
  if (read.document.basis === "consolidated") return `the filing is a group's: the first read took the consolidated statements${registerWords}`;
  for (const key of BASE_LINE_KEYS) {
    const line = read.lines[key];
    if (line?.status === "found" && printsGroupStatement(line.statement)) {
      return `the filing is a group's: it prints "${line.statement.trim()}"${registerWords}`;
    }
  }
  return null;
}

export type BasisJudgement = { ok: true; evidence: BasisEvidence } | { ok: false; reason: string };

export function judgeBasis(
  first: FoundLine,
  documentBasis: VisionReadResult["document"]["basis"],
  wire: SecondWireLine,
  why: string = "the filing is group accounts"
): BasisJudgement {
  const headings: { what: string; text: string }[] = [
    { what: "the statement the first read cited", text: first.statement },
    { what: "the statement the second read gave", text: wire.statement },
    { what: "the words the second read gave for the basis", text: wire.basis_text },
    { what: "the column heading", text: wire.column_heading },
    // WP-BE22: the header rows over the column are printed headings for the line too, so a
    // "Company" spanning the column abstains it, and a "Group" spanning it counts as group wording.
    ...(wire.header_rows_above ?? []).slice(0, MAX_HEADER_ROWS_ABOVE).map((text) => ({ what: "a header row above the column", text })),
  ].map((h) => ({ ...h, text: (h.text ?? "").trim() }));

  const companyHeading = headings.find((h) => headingBasis(h.text) === "company");
  if (companyHeading) {
    return {
      ok: false,
      reason: `${BASIS_ABSTAIN}: ${why}, but ${companyHeading.what} is "${companyHeading.text}", the company's own figures, not the group's.`,
    };
  }
  if (wire.basis === "company") {
    const said = wire.basis_text.trim() ? ` ("${wire.basis_text.trim()}")` : "";
    return {
      ok: false,
      reason: `${BASIS_ABSTAIN}: ${why}, but the second read found this figure in the company's own statements${said}.`,
    };
  }
  if (documentBasis !== "consolidated") {
    return {
      ok: false,
      reason: `${BASIS_ABSTAIN}: ${why}, but the first read took the ${documentBasis === "company" ? "company's own" : "unstated"} statements, not the consolidated ones.`,
    };
  }
  if (wire.basis !== "consolidated") {
    return {
      ok: false,
      reason: `The two reads did not agree on the basis: the first read took the consolidated statements, and the second read could not tell from the page whether "${first.statement}" is the group's or the company's. In a group filing that is how a company-only figure passes for the group's, so it is not shown.`,
    };
  }
  const groupHeading = headings.find((h) => headingBasis(h.text) === "group");
  if (!groupHeading) {
    return {
      ok: false,
      reason: `${BASIS_ABSTAIN}: ${why}, and nothing printed for this figure says "consolidated" or "group" (statement "${first.statement}"${wire.column_heading.trim() ? `, column "${wire.column_heading.trim()}"` : ""}), so it could be the company's own.`,
    };
  }
  return { ok: true, evidence: { first: "consolidated", second: "consolidated", heading: groupHeading.text } };
}

// ---------------------------------------------------------------------------
// Ties
// ---------------------------------------------------------------------------

interface TieInput {
  name: string; // plain words, e.g. "net assets"
  pounds: number; // printed sign kept
  unit: number;
}

type Resolved = { ok: true; input: TieInput } | { ok: false; why: string };

const LINE_WORDS: Partial<Record<BaseLineKey, string>> = {
  net_assets: "net assets",
  total_assets: "total assets",
  current_liabilities: "current liabilities",
  net_current_liabilities: "net current assets",
  cash_at_bank: "cash",
  borrowings_within_one_year: "borrowings due within one year",
  borrowings_after_one_year: "borrowings due after one year",
  lease_liabilities_total: "lease liabilities (total)",
  lease_liabilities_current: "lease liabilities due within one year",
  lease_liabilities_non_current: "lease liabilities due after one year",
};
const ROLE_WORDS: Record<TieRole, string> = {
  total_equity: "total equity",
  total_liabilities: "total liabilities",
  current_assets: "current assets",
  borrowings_total: "total borrowings",
  net_debt: "net debt",
};

// The period every figure in a tie must be for. The accounts period when the first read gives
// one; otherwise the one period every agreed line was read for (WP-QA05). Without the fallback a
// filing with no period on its cover ran its ties with no period check at all, so a total read
// off the comparative column could vouch for this year's lines.
type TiePeriod = { ok: true; period: string } | { ok: false; why: string };

function tiePeriod(agreed: Map<BaseLineKey, Candidate>, first: VisionReadResult): TiePeriod {
  if (first.document.periodEnd) return { ok: true, period: first.document.periodEnd };
  const periods = [...new Set([...agreed.values()].map((c) => c.first.periodEnd))];
  if (periods.length === 1) return { ok: true, period: periods[0] };
  return {
    ok: false,
    why: periods.length ? "the agreed lines were read for different periods and the accounts period is not known" : "the accounts period is not known",
  };
}

function fromLine(key: BaseLineKey, agreed: Map<BaseLineKey, Candidate>, first: VisionReadResult, period: TiePeriod): Resolved {
  const c = agreed.get(key);
  const name = LINE_WORDS[key] ?? key;
  if (c && !period.ok) return { ok: false, why: `${name} could not be tied to one period: ${period.why}` };
  if (c && period.ok && c.first.periodEnd !== period.period) return { ok: false, why: `${name} was read for a different period` };
  if (c) return { ok: true, input: { name, pounds: c.pounds, unit: c.unit } };
  const printed = first.lines[key]?.status === "found";
  return { ok: false, why: printed ? `${name} was not agreed by both reads` : `${name} was not read` };
}

function fromRole(role: TieRole, wire: SecondReadWire, period: TiePeriod): Resolved {
  const name = ROLE_WORDS[role];
  const t = wire.tie_lines.find((l) => l.role === role);
  if (!t || t.status === "abstain") return { ok: false, why: `${name} is not printed on the pages read` };
  const v = secondReadValue(t.figure_text, t.sign);
  const s = scaleFromCaption(t.scale_caption);
  if (v === null || s === null) return { ok: false, why: `${name} could not be read with its scale` };
  if (!period.ok) return { ok: false, why: `${name} could not be tied to one period: ${period.why}` };
  if (t.period_end.trim() !== period.period) return { ok: false, why: `${name} was read for a different period` };
  return {
    ok: true,
    input: { name, pounds: toPence(v * s), unit: s * Math.pow(10, -printedDecimals(t.figure_text)) },
  };
}

// Half of the last printed digit for every figure in the identity: each printed figure is
// rounded, so a printed total can differ from the sum of printed parts by that much and no more.
function tolerance(inputs: TieInput[]): number {
  return inputs.reduce((s, i) => s + i.unit / 2, 0) + 0.005;
}

function tie(
  id: string,
  label: string,
  lines: BaseLineKey[],
  parts: Resolved[],
  compute: (v: TieInput[]) => { left: number; right: number; text: string }[]
): TieResult {
  const missing = parts.filter((p): p is { ok: false; why: string } => !p.ok);
  if (missing.length) {
    return { id, label, status: "not-run", detail: `Not run: ${missing.map((m) => m.why).join("; ")}.`, outBy: null, lines };
  }
  const inputs = parts.map((p) => (p as { ok: true; input: TieInput }).input);
  const tol = tolerance(inputs);
  // More than one accepted form (net debt with or without leases): the tie holds if any does.
  const forms = compute(inputs);
  const held = forms.find((f) => Math.abs(f.left - f.right) <= tol);
  if (held) return { id, label, status: "pass", detail: `${held.text}: holds.`, outBy: null, lines };
  const closest = forms.reduce((a, b) => (Math.abs(a.left - a.right) <= Math.abs(b.left - b.right) ? a : b));
  const outBy = toPence(Math.abs(closest.left - closest.right));
  return { id, label, status: "fail", detail: `${closest.text}, out by ${pounds(outBy)}.`, outBy, lines };
}

// The ties that can run on one filing, in two passes. The balance sheet and borrowings ties run
// first. Lines a failed tie condemns are then taken out before the net debt tie runs, so net debt
// is never tested with a borrowings figure already shown not to add up (it falls back to a
// printed total). Assets and liabilities are compared as balances (UK statements print creditors
// in brackets), and net lines keep their printed sign.
export function runTies(agreed: Map<BaseLineKey, Candidate>, first: VisionReadResult, wire: SecondReadWire): TieResult[] {
  const statement = statementTies(agreed, first, wire);
  const condemned = new Set(statement.filter((t) => t.status === "fail").flatMap((t) => t.lines));
  const survivors = new Map([...agreed].filter(([k]) => !condemned.has(k)));
  return [...statement, netDebtTie(survivors, first, wire)];
}

function statementTies(agreed: Map<BaseLineKey, Candidate>, first: VisionReadResult, wire: SecondReadWire): TieResult[] {
  const period = tiePeriod(agreed, first);
  const L = (k: BaseLineKey) => fromLine(k, agreed, first, period);
  const R = (r: TieRole) => fromRole(r, wire, period);
  const abs = Math.abs;
  const results: TieResult[] = [];

  results.push(
    tie("balance-sheet.net-assets-equity", "Balance sheet: net assets equal total equity", ["net_assets"], [L("net_assets"), R("total_equity")], ([na, te]) => [
      { left: na.pounds, right: te.pounds, text: `Net assets ${pounds(na.pounds)} against total equity ${pounds(te.pounds)}` },
    ])
  );
  results.push(
    tie(
      "balance-sheet.assets-liabilities",
      "Balance sheet: total assets less total liabilities equal net assets",
      ["total_assets", "net_assets"],
      [L("total_assets"), R("total_liabilities"), L("net_assets")],
      ([ta, tl, na]) => [
        {
          left: abs(ta.pounds) - abs(tl.pounds),
          right: na.pounds,
          text: `Total assets ${pounds(abs(ta.pounds))} less total liabilities ${pounds(abs(tl.pounds))} is ${pounds(abs(ta.pounds) - abs(tl.pounds))}, against net assets ${pounds(na.pounds)}`,
        },
      ]
    )
  );
  results.push(
    tie(
      "balance-sheet.working-capital",
      "Balance sheet: current assets less current liabilities equal net current assets",
      ["current_liabilities", "net_current_liabilities"],
      [R("current_assets"), L("current_liabilities"), L("net_current_liabilities")],
      ([ca, cl, nca]) => [
        {
          left: abs(ca.pounds) - abs(cl.pounds),
          right: nca.pounds,
          text: `Current assets ${pounds(abs(ca.pounds))} less current liabilities ${pounds(abs(cl.pounds))} is ${pounds(abs(ca.pounds) - abs(cl.pounds))}, against net current assets ${pounds(nca.pounds)}`,
        },
      ]
    )
  );
  results.push(
    tie(
      "borrowings.split-total",
      "Borrowings: the maturity split adds to total borrowings",
      ["borrowings_within_one_year", "borrowings_after_one_year"],
      [L("borrowings_within_one_year"), L("borrowings_after_one_year"), R("borrowings_total")],
      ([bw, ba, bt]) => [
        {
          left: abs(bw.pounds) + abs(ba.pounds),
          right: abs(bt.pounds),
          text: `Borrowings ${pounds(abs(bw.pounds))} within one year and ${pounds(abs(ba.pounds))} after is ${pounds(abs(bw.pounds) + abs(ba.pounds))}, against total borrowings ${pounds(abs(bt.pounds))}`,
        },
      ]
    )
  );

  return results;
}

function netDebtTie(agreed: Map<BaseLineKey, Candidate>, first: VisionReadResult, wire: SecondReadWire): TieResult {
  const period = tiePeriod(agreed, first);
  const L = (k: BaseLineKey) => fromLine(k, agreed, first, period);
  const R = (r: TieRole) => fromRole(r, wire, period);
  const abs = Math.abs;
  // Net debt: borrowings less cash against the printed net debt. Borrowings are the agreed
  // maturity split where both lines are agreed, else a printed total. UK net debt analyses
  // differ on leases, so the tie holds if either definition does; it fails only when neither
  // does. It runs only when cash and borrowings are both read.
  const bw = L("borrowings_within_one_year");
  const ba = L("borrowings_after_one_year");
  const bt = R("borrowings_total");
  const split = bw.ok && ba.ok;
  const borrowings: Resolved = split
    ? { ok: true, input: { name: "borrowings", pounds: abs(bw.input.pounds) + abs(ba.input.pounds), unit: bw.input.unit + ba.input.unit } }
    : bt.ok
      ? bt
      : !agreed.has("borrowings_within_one_year") && !agreed.has("borrowings_after_one_year")
        ? { ok: false, why: "borrowings were not agreed by both reads" }
        : { ok: false, why: "only one side of the borrowings maturity split was agreed, and no total is printed" };
  // Only the lines the arithmetic used are bound by it (WP-QA05). When the printed total stands in
  // for borrowings, a lone agreed maturity line took no part, so the tie neither vouches for it
  // nor condemns it.
  const borrowingLines: BaseLineKey[] = split ? ["borrowings_within_one_year", "borrowings_after_one_year"] : [];
  // The lease total when both reads agreed it; else the agreed current and non-current lines (WP-BE23).
  const lt = agreed.get("lease_liabilities_total");
  const lc = agreed.get("lease_liabilities_current");
  const ln = agreed.get("lease_liabilities_non_current");
  const leases = lt ?? (lc && ln ? { pounds: Math.abs(lc.pounds) + Math.abs(ln.pounds) } : undefined);
  const label = wire.tie_lines.find((l) => l.role === "net_debt")?.printed_label ?? "";
  return tie(
      "net-debt.borrowings-cash",
      "Net debt: borrowings less cash equal the printed net debt",
      ["cash_at_bank", ...borrowingLines],
      [borrowings, L("cash_at_bank"), R("net_debt")],
      ([b, cash, nd]) => {
        const plain = abs(b.pounds) - abs(cash.pounds);
        const forms: { left: number; right: number; text: string }[] = [];
        for (const want of netDebtReadings(label, nd.pounds)) {
          forms.push({ left: plain, right: want, text: `Borrowings ${pounds(abs(b.pounds))} less cash ${pounds(abs(cash.pounds))} is ${pounds(plain)}, against printed net debt ${pounds(want)}` });
          if (leases) {
            const withLeases = plain + abs(leases.pounds);
            forms.push({ left: withLeases, right: want, text: `Borrowings and leases ${pounds(abs(b.pounds) + abs(leases.pounds))} less cash ${pounds(abs(cash.pounds))} is ${pounds(withLeases)}, against printed net debt ${pounds(want)}` });
          }
        }
        return forms;
      }
    );
}

// What borrowings less cash must equal, given the printed net debt line (WP-QA05). Accepting both
// signs let a read that swapped cash and borrowings pass: 100 of borrowings and 300 of cash is
// -200, and a printed net debt of 200 matched it negated. The printed label settles the sign:
//   - "Net funds" or "Net cash" is cash less borrowings, so borrowings less cash is its negative.
//   - "Net debt" printed without brackets is borrowings less cash as it stands.
//   - "Net debt" printed in brackets is still ambiguous. A net debt analysis that prints debt as a
//     negative puts net debt of 200 in brackets (the recorded 03558065 filing does), and one that
//     prints debt as positive puts net cash of 200 there. Both readings stay until a product
//     decision picks one (see the skipped test in test/qa05b.test.ts).
//   - A label that names neither keeps both readings, as before.
export function netDebtReadings(printedLabel: string, printed: number): number[] {
  const l = printedLabel.toLowerCase();
  const debt = /\bdebt\b/.test(l);
  const funds = /\b(funds|cash)\b/.test(l);
  if (funds && !debt) return [-printed];
  if (debt && !funds && printed >= 0) return [printed];
  return [printed, -printed];
}

// ---------------------------------------------------------------------------
// The whole judgement, from a first read and a parsed second read. Pure: the same inputs give
// the same verdict, so a cached second read reproduces a verification exactly.
// ---------------------------------------------------------------------------

export interface JudgeOptions {
  accountsType?: AccountsTypeLabel | null; // "group" turns on the basis check
  // The first read, so the landing rule can see a group filer the register does not label as one
  // (WP-GRPCHK, groupFilerWhy). judgeDoubleRead has the read already.
  read?: Pick<VisionReadResult, "document" | "lines"> | null;
}

export function judgeDoubleRead(
  first: VisionReadResult,
  wire: SecondReadWire,
  pages: number[],
  verifierName: string = DOUBLE_READ_VERIFIER_NAME,
  options: JudgeOptions = {}
): Pick<VisionVerifyResult, "lines" | "overrides"> {
  const groupWhy = groupFilerWhy(options.accountsType, first);
  const basisOf = new Map<BaseLineKey, BasisEvidence>();
  const lines = everyLine({ tag: "not-checked", note: "The reader abstained on this line, so there was nothing to check." });
  const overrides: Partial<Record<BaseLineKey, AbstainLine>> = {};
  const reject = (key: BaseLineKey, reason: string) => {
    lines[key] = { tag: "rejected", note: reason };
    overrides[key] = { status: "abstain", reason };
  };

  const byKey = new Map(wire.lines.map((l) => [l.key, l]));
  const agreed = new Map<BaseLineKey, Candidate>();
  for (const key of BASE_LINE_KEYS) {
    const line = first.lines[key];
    if (line.status !== "found") continue;
    const j = judgeLine(key, line, byKey.get(key), pages, first.document.periodEnd);
    if (!j.ok) {
      reject(key, j.reason);
      continue;
    }
    if (groupWhy) {
      // judgeLine only passes a line the second read returned, so the wire line is there.
      const b = judgeBasis(line, first.document.basis, byKey.get(key)!, groupWhy);
      if (!b.ok) {
        reject(key, b.reason);
        continue;
      }
      basisOf.set(key, b.evidence);
    }
    agreed.set(key, j.candidate);
  }

  const ties = runTies(agreed, first, wire);
  for (const [key, c] of agreed) {
    const mine = ties.filter((t) => t.lines.includes(key));
    const failed = mine.find((t) => t.status === "fail");
    if (failed) {
      // A net debt analysis can define net debt differently from the balance sheet (gross of
      // issue costs, with or without accrued interest), so the reason says a failure may be that
      // rather than a misread. Either way the figure is not shown.
      const caveat = failed.id.startsWith("net-debt")
        ? " This can be a misread, or a printed net debt defined differently from the balance sheet lines; either way the figure is not shown."
        : "";
      reject(key, `The printed figures do not add up. ${failed.label} failed: ${failed.detail}${caveat}`);
      continue;
    }
    const passed = mine.filter((t) => t.status === "pass");
    const evidence: DoubleReadEvidence = {
      kind: "double-read",
      verifier: verifierName,
      first: {
        figureText: c.first.figureText,
        value: c.first.value,
        scaleCaption: c.first.scaleCaption,
        periodEnd: c.first.periodEnd,
        pdfPageIndex: c.first.pdfPageIndex,
      },
      second: c.second,
      scale: c.scale,
      pounds: c.pounds,
      ties: mine,
      ...(basisOf.has(key) ? { basis: basisOf.get(key)! } : {}),
    };
    const tieWords = passed.length ? ` ${passed.map((t) => `${t.label}: ${t.detail}`).join(" ")}` : "";
    const basisWords = evidence.basis ? ` Both reads put it in the group accounts, under "${evidence.basis.heading}".` : "";
    const ps = c.second.periodSource;
    const periodWords =
      ps?.from === "header-row"
        ? ` The column heading prints no year; the period ${c.second.periodEnd} is from the header row above it in the same table, "${ps.text}".`
        : "";
    lines[key] = {
      tag: "verified",
      note: `Read twice and agreed: "${c.first.figureText}" under "${c.second.headerScaleCaption}", column "${c.second.columnHeading}".${periodWords}${basisWords}${tieWords}`,
      evidence,
    };
  }
  return { lines, overrides };
}

// ---------------------------------------------------------------------------
// The landing rule: does a line's tag carry a double read that agrees with it?
// ---------------------------------------------------------------------------

// Null when the line may surface; otherwise the reason it may not. lib/sources/visionAccounts.ts
// calls this for every found line, whatever verifier ran, so a verifier that tags "verified"
// without a second read, or with a second read of a different figure, cannot land one.
export function doubleReadProblem(line: FoundLine, tag: VerifiedLine | undefined, options: JudgeOptions = {}): string | null {
  if (!tag || tag.tag !== "verified") {
    const why = tag?.note ? ` ${tag.note}` : "";
    return `Seen by one read only, so not shown.${why}`;
  }
  const e = tag.evidence;
  if (!e || e.kind !== "double-read" || !e.second) {
    return `Seen by one read only, so not shown. The check named no second read.`;
  }
  const sameFirst =
    e.first.figureText === line.figureText &&
    e.first.value === line.value &&
    e.first.scaleCaption === line.scaleCaption &&
    e.first.periodEnd === line.periodEnd &&
    e.first.pdfPageIndex === line.pdfPageIndex;
  if (!sameFirst) return `Seen by one read only, so not shown. The second read on record is for a different figure.`;
  const s1 = scaleFromCaption(line.scaleCaption);
  const s2 = scaleFromCaption(e.second.scaleCaption);
  const sh = scaleFromCaption(e.second.headerScaleCaption);
  if (s1 === null || s1 !== e.scale || s2 !== e.scale || sh !== e.scale) {
    return `The scale did not match the statement header, so the figure is not shown.`;
  }
  if (toPence(line.value * s1) !== e.pounds || toPence(e.second.value * s2) !== e.pounds) {
    return `The two reads disagreed: "${line.figureText}" against "${e.second.figureText}".`;
  }
  // The currency is re-checked too (WP-QA05). judgeLine rejects a non-sterling header, but a
  // verifier other than the default could record euro evidence and tag it verified.
  if (e.second.currency !== "GBP") {
    return `The figure is printed in ${e.second.currency || "an unstated currency"}, and this sheet is in pounds, so it is not shown.`;
  }
  if (e.second.periodEnd !== line.periodEnd) {
    return `The period did not match: ${line.periodEnd} against ${e.second.periodEnd}.`;
  }
  // The period is re-established from the headings on record (WP-BE22), so a verifier cannot
  // land a figure whose headings never supported its period, nor claim a header row it did not
  // record. Evidence recorded before WP-BE22 carries no header rows and is judged on its column
  // heading alone, which is the test it passed when it was made.
  const period = periodFromHeadings(e.second.columnHeading, e.second.headerRowsAbove ?? [], line.periodEnd);
  if (!period.ok) return period.reason;
  const failed = e.ties.find((t) => t.status === "fail");
  if (failed) return `The printed figures do not add up. ${failed.label} failed: ${failed.detail}`;
  // A group filing's figure lands only with the basis check on its record (WP-BE18), so a
  // verifier that skipped the check cannot put a company-only figure on a group sheet.
  const groupWhy = groupFilerWhy(options.accountsType, options.read);
  if (groupWhy) {
    const b = e.basis;
    if (!b || b.first !== "consolidated" || b.second !== "consolidated" || headingBasis(b.heading) !== "group") {
      return `${BASIS_ABSTAIN}: ${groupWhy}, and the check on record does not show both reads putting this figure in the group's statements.`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The verifier
// ---------------------------------------------------------------------------

export interface DoubleReadDeps {
  provider?: StructuredLLMProvider | null; // default: the env-configured Anthropic provider
  cache?: Cache; // default: getCache()
  // Serve a cached second read or abstain; never make a model call. A universe screen runs
  // here, as it does for the first read, so a sweep cannot spend.
  cacheOnly?: boolean;
  maxTokens?: number;
}

interface CachedSecondRead {
  wire: SecondReadWire;
  pages: number[];
  usage: LLMUsage | null;
}

export function secondReadCacheKey(model: string, transactionId: string, pages: number[], keys: BaseLineKey[]): string {
  return `vision-verify:v${SECOND_READ_SCHEMA_VERSION}:${SECOND_READ_PROMPT_VERSION}:${secondReadPromptHash()}:e${SECOND_READ_EFFORT}:${model}:${transactionId}:p${pages.join(",")}:${keys.join(",")}`;
}

export class DoubleReadVerifier implements VisionVerifier {
  readonly name = DOUBLE_READ_VERIFIER_NAME;
  constructor(private readonly deps: DoubleReadDeps = {}) {}

  async verify(input: VisionVerifyInput): Promise<VisionVerifyResult> {
    const { read, pdfBytes } = input;
    const judgeOptions: JudgeOptions = { accountsType: input.accountsType ?? null };
    const found = BASE_LINE_KEYS.filter((k) => read.lines[k].status === "found");
    const base = everyLine({ tag: "not-checked", note: "The reader abstained on this line, so there was nothing to check." });
    const result = (lines: Record<BaseLineKey, VerifiedLine>, overrides: VisionVerifyResult["overrides"], usage: LLMUsage | null): VisionVerifyResult => ({
      verifier: this.name,
      lines,
      overrides,
      usage,
    });
    if (found.length === 0) return result(base, {}, null);

    const rejectAll = (reason: string, usage: LLMUsage | null = null): VisionVerifyResult => {
      const lines = { ...base };
      const overrides: VisionVerifyResult["overrides"] = {};
      for (const k of found) {
        lines[k] = { tag: "rejected", note: reason };
        overrides[k] = { status: "abstain", reason };
      }
      return result(lines, overrides, usage);
    };

    // Only the pages the first read cited.
    const pages = [...new Set(found.map((k) => (read.lines[k] as FoundLine).pdfPageIndex))].sort((a, b) => a - b);
    const subset = await cutPdfPages(pdfBytes, pages);
    if (!subset) {
      return rejectAll(
        `No second read was made: ${pageList(pages)} could not be cut out of this PDF, and the whole filing is never sent for a second read. ${SINGLE_READ}`
      );
    }

    const provider = this.deps.provider !== undefined ? this.deps.provider : getAnthropicProvider();
    const cache = this.deps.cache ?? getCache();
    const key = secondReadCacheKey(cacheModelFor(provider), read.transactionId, subset.pages, found);
    const cached = await cache.get<CachedSecondRead>(key);
    if (cached) {
      // A cached second read makes no call, so it reports no usage of its own.
      const judged = judgeDoubleRead(read, cached.wire, cached.pages, this.name, judgeOptions);
      return result(judged.lines, judged.overrides, null);
    }
    if (this.deps.cacheOnly) {
      return rejectAll(`No second read is held for this filing, and this run may not pay for one. ${SINGLE_READ}`);
    }
    if (!provider) {
      return rejectAll(`No second read was made: no model is configured. ${SINGLE_READ}`);
    }

    const sent = await provider.send({
      system: SECOND_READ_SYSTEM_PROMPT,
      content: [
        {
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: Buffer.from(subset.bytes).toString("base64") },
        },
        { type: "text", text: secondReadUserText(read.companyNumber, found, subset.pages.length) },
      ],
      maxTokens: this.deps.maxTokens ?? SECOND_READ_MAX_TOKENS,
      outputSchema: SECOND_READ_SCHEMA,
      effort: SECOND_READ_EFFORT,
      label: `vision-verify:${read.companyNumber}`,
    });
    if (!sent.ok) {
      return rejectAll(`No second read was made: the model call failed (${sent.failure.kind}). ${SINGLE_READ}`, sent.usage);
    }
    const parsed = parseSecondRead(sent.text);
    if (!parsed.ok) {
      return rejectAll(`The second read came back in a shape that could not be checked, so it confirms nothing. ${SINGLE_READ}`, sent.usage);
    }
    await cache.set<CachedSecondRead>(key, { wire: parsed.value, pages: subset.pages, usage: sent.usage }, SECOND_READ_CACHE_TTL_SECONDS);
    const judged = judgeDoubleRead(read, parsed.value, subset.pages, this.name, judgeOptions);
    return result(judged.lines, judged.overrides, sent.usage);
  }
}

// Which second read runs (WP-OCR2). VISION_SECOND_READ=ocr reads the cited pages with local Apple
// Vision OCR (lib/vision/ocrVerify.ts) and makes no model call; anything else, or nothing, keeps the
// model second read. The model stays the default because on the UK gold set (24 Sep 2026) OCR
// confirmed 45 of 85 surfaced figures against the model's 77, although it confirmed none the gold
// set disagrees with and the model confirmed 3 (docs/programme/reports/WP-OCR2.md).
//
// VISION_SECOND_READ=hybrid (WP-OCR3) reads every line with OCR first and pays for the model second
// read only on the lines OCR abstained on (lib/vision/hybridVerify.ts). The model stays the default
// until Cam decides otherwise (docs/programme/reports/WP-OCR3.md).
export type SecondReadMode = "model" | "ocr" | "hybrid";

export function secondReadMode(env: string | undefined = process.env.VISION_SECOND_READ): SecondReadMode {
  const v = (env ?? "").trim().toLowerCase();
  return v === "ocr" || v === "hybrid" ? v : "model";
}

export function createVisionVerifier(deps: DoubleReadDeps & OcrVerifierDeps = {}, mode: SecondReadMode = secondReadMode()): VisionVerifier {
  if (mode === "ocr") return new OcrSecondReadVerifier({ pages: deps.pages });
  if (mode === "hybrid") {
    return new HybridSecondReadVerifier({ ocr: new OcrSecondReadVerifier({ pages: deps.pages }), model: new DoubleReadVerifier(deps) });
  }
  return new DoubleReadVerifier(deps);
}

// ---------------------------------------------------------------------------
// Applying a verification
// ---------------------------------------------------------------------------

export interface VerifiedRead {
  read: VisionReadResult; // the read with any rejected line turned into an abstention
  verification: VisionVerifyResult;
  tags: Record<BaseLineKey, VerifiedLine>;
}

// Apply a verification to a read. A rejected line becomes an abstention carrying the verifier's
// reason; nothing else about a line can change, so a verifier cannot introduce a figure, move a
// page or restate a scale. A verifier that overrides a line the reader already abstained is
// ignored, because there is nothing to reject. A line the verifier did not reject still has to
// pass doubleReadProblem when it is mapped, so "not rejected" never means "shown".
export function applyVerification(read: VisionReadResult, verification: VisionVerifyResult): VerifiedRead {
  const lines: Record<BaseLineKey, VisionLine> = { ...read.lines };
  const tags: Record<BaseLineKey, VerifiedLine> = {} as Record<BaseLineKey, VerifiedLine>;
  for (const key of BASE_LINE_KEYS) {
    const tag = verification.lines[key] ?? { tag: "not-checked", note: null };
    const override = verification.overrides[key];
    if (override && lines[key].status === "found") {
      lines[key] = { status: "abstain", reason: override.reason };
      tags[key] = { tag: "rejected", note: tag.note };
    } else {
      tags[key] = tag;
    }
  }
  return { read: { ...read, lines }, verification, tags };
}

// The verification a read carries when no verifier ran at all, so callers never have to hold a
// null and a figure can never be shown without a tag. Nothing tagged this way surfaces.
export function unverified(): Record<BaseLineKey, VerifiedLine> {
  return everyLine({ tag: "unverified", note: null });
}
