// lib/vision/capitalStructure.ts
// The facilities table from the debt note of a scanned filing (WP-BE16).
//
// The first read already lists the facilities printed in the borrowings note (lib/vision/types.ts
// Facility). A single read of a scan is never shown (WP-BE05), so this module makes a second,
// independent read of the debt-note pages and puts a cell on the sheet only where the two agree.
//
// The second read is sent only the pages the first read gave for the debt note, cut out as a new
// PDF, and is told nothing the first read found: no names, no amounts, no dates. It lists what it
// sees. The two lists are then paired facility by facility, and each cell is judged on its own:
//
//   - an amount agrees when both reads give the same figure in pounds, with a scale written beside
//     it ("£25.0m") or printed at the head of the note, in pounds sterling, and, for the amount
//     drawn, at the balance sheet date. An amount printed as words ("undrawn", "nil") is shown as
//     those words and never turned into a zero.
//   - a maturity or a rate agrees when both reads carry the same dates, years, percentages and
//     reference rates. Otherwise, and for security and lender, the words must be the same words.
//   - ranking is shown only as the note's own words, only when both reads copied words that state
//     a ranking ("super senior", "subordinated to", "pari passu"), and never as an order. Rows are
//     kept in the order the note prints them. There is no fulcrum, here or anywhere on a live
//     sheet: no note states where value breaks, so the engine never says it.
//
// A cell neither read found says "not printed". A cell only one read found, or the reads disagree
// on, abstains with its reason. A row both reads did not list abstains. On group accounts the
// note must be the group's (the WP-BE18 basis check, applied to the note heading), or the whole
// table abstains. Nothing here creates a number: every figure is parsed from printed characters,
// and a check can only take a cell away.
//
// Same wire rules as lib/vision/schema.ts: no nullables, every property required, "" for text not
// printed, 0 for a page not known.

import { createHash } from "node:crypto";
import { getCache, type Cache } from "../cache/cache";
import { getAnthropicProvider } from "../llm/config";
import { cacheModelFor } from "./cache";
import type { LLMEffort, LLMUsage, StructuredLLMProvider } from "../llm/types";
import type { AccountsTypeLabel } from "../resolve/accountsType";
import type { CapitalStructure, FacilityCell, FacilityCellKey, FacilityRow } from "../engine/types";
import { FACILITY_CELL_KEYS } from "../engine/types";
import { scaleFromCaption, toPence } from "./scale";
import { cutPdfPages } from "./pages";
import { validateAgainstSchema, WIRE_FACILITY_TYPES } from "./schema";
import { BASIS_VALUES, type SecondReadBasis } from "./secondRead";
import { currencyFromText, groupFilerWhy, headingBasis, periodFromHeading, pounds as poundsText } from "./verify";
import type { Facility, VisionReadResult } from "./types";

// v2: the column heading of the amount drawn, so its period and basis are established from the
// page as WP-BE05 and WP-BE18 establish a line's (the column heading was missing from v1).
// v3: the prompt's examples are neutral. v1 and v2 had taken three of them from the gold filings
// (a note heading, two amounts and two ranking phrases), which a gold eval must never see.
// v4: the basis words must be a printed heading (the note's heading, the page title or a column
// heading), never a sentence from the body. v1 to v3 also accepted "the note itself speaks of the
// group", and on 22 Sep 2026 the same Solid State note passed or failed the basis check depending on
// which body sentence the second read copied. A parent company's own note can speak of the group's
// facilities, so a sentence is not evidence of whose note it is. This is WP-BE18's rule.
export const FACILITY_READ_SCHEMA_VERSION = 2;
export const FACILITY_READ_PROMPT_VERSION = "v4";
export const FACILITY_READER_NAME = `facility-read/${FACILITY_READ_PROMPT_VERSION}`;
export const FACILITY_READ_MAX_TOKENS = 8_000;
// "medium", as for the line second read (WP-BE18): a read that thinks less can fail to agree, which
// abstains a cell; it cannot supply one. It is in the cache key.
export const FACILITY_READ_EFFORT: LLMEffort = "medium";
// A borrowings note runs to one to four pages. More than this and the first read has pointed at
// something that is not a debt note, so nothing is sent.
export const FACILITY_READ_MAX_PAGES = 8;
const FACILITY_READ_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;

const SINGLE_READ = "A cell seen by one read only is never shown.";
const NO_FACILITIES = "The debt note was read, but it lists no facility other than leases.";

// ---------------------------------------------------------------------------
// The second read: prompt and schema
// ---------------------------------------------------------------------------

type JsonSchema = Record<string, unknown>;
const text = (): JsonSchema => ({ type: "string" });
const int = (): JsonSchema => ({ type: "integer" });
const oneOf = (values: readonly string[]): JsonSchema => ({ type: "string", enum: [...values] });
const obj = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

const FACILITY_WIRE_SCHEMA = obj({
  name_as_printed: text(),
  type: oneOf(WIRE_FACILITY_TYPES),
  lender: text(),
  amount_drawn_text: text(),
  drawn_column_heading: text(),
  drawn_period_end: text(),
  facility_size_text: text(),
  maturity: text(),
  rate_or_margin: text(),
  security: text(),
  ranking_text: text(),
  excerpt_page: int(),
});

export const FACILITY_READ_SCHEMA: JsonSchema = obj({
  note: obj({
    status: oneOf(["found", "abstain"]),
    abstain_reason: text(),
    heading: text(),
    header_scale_caption: text(),
    header_currency: text(),
    basis: oneOf(BASIS_VALUES),
    basis_text: text(),
  }),
  facilities: { type: "array", items: FACILITY_WIRE_SCHEMA },
});

export const FACILITY_READ_SYSTEM_PROMPT = `You check the borrowings note in UK statutory accounts filed at Companies House. You are given an excerpt of a filing: a few pages cut out of a longer PDF, usually scanned. Read the page images. You transcribe what is printed. You never calculate, convert, add up, rescale or infer.

The note
1. heading is the heading of the borrowings, loans or bank facilities note as printed, such as "14. Loans and overdrafts". If these pages hold no such note, set status to "abstain" with a short reason, and return no facilities.
2. header_scale_caption is the unit caption printed at the head of the note or of its table, copied exactly, such as "£'000" or "£m". Give "" if none is printed on these pages.
3. header_currency is the currency that caption or heading states, as printed, or "".
4. basis says whose note it is, judged only from printed headings: the note's own heading, the page title printed at the top or bottom of the page, and the column headings of its tables. "consolidated" when a heading says the note is the group's or consolidated, such as the page title "Notes to the consolidated financial statements" or a column headed "Group"; "company" when a heading says it is the parent company's own, such as "Notes to the company financial statements" or a column headed "Company"; "none" if no heading on these pages says. A sentence in the body of the note is not a heading. basis_text is the heading words that say it, copied exactly, or "" when no heading says it.

The facilities. List each facility, loan, note, bond, overdraft or other borrowing arrangement the note prints, once each, in the order printed. Leases and preference shares are not facilities; leave them out.
5. name_as_printed is its name exactly as printed. type is one of the listed types, or "none".
6. lender is the lender's name only if printed, else "".
7. amount_drawn_text is the amount drawn or outstanding at the balance sheet date, exactly as printed, with any currency sign and unit written beside it, such as "£25.0m", "4,210" or "nil". Never a comparative year's amount. drawn_column_heading is the heading of the table column the amount is read from, exactly as printed, such as "2026" or "Group 2026", or "" when the amount is in a sentence. drawn_period_end is the date that amount is at, as YYYY-MM-DD, or "" if the page does not say.
8. facility_size_text is the committed size of the facility exactly as printed, with any sign and unit written beside it, such as "£40m". Never an uncommitted accordion or an option to increase.
9. maturity is the maturity date or term, as printed. rate_or_margin is the interest rate or margin, as printed. security is the words that say how it is secured, as printed.
10. ranking_text is only the words the note uses to say how this debt ranks against other debt, copied exactly, such as "ranks pari passu with", "second lien" or "subordinated to". A word in a facility's name is not a ranking unless the note uses it to describe how the debt ranks. Give "" when the note does not state a ranking.
11. excerpt_page is the page of THIS excerpt the facility is described on, where the first page of the excerpt is 1.
12. Any field not printed is "". An empty field is a correct answer. A guess is a wrong one.

Answer with the JSON object only.`;

export function facilityReadUserText(companyNumber: string, excerptPages: number): string {
  return `This excerpt is ${excerptPages} page${excerptPages === 1 ? "" : "s"} of the latest filed accounts for Companies House company number ${companyNumber}. List the facilities in the borrowings note under the rules.`;
}

export function facilityReadPromptHash(): string {
  return createHash("sha256")
    .update(FACILITY_READ_SYSTEM_PROMPT)
    .update(facilityReadUserText("{companyNumber}", 0))
    .update(JSON.stringify(FACILITY_READ_SCHEMA))
    .digest("hex")
    .slice(0, 12);
}

export function facilityReadCacheKey(model: string, transactionId: string, pages: number[]): string {
  return `vision-facilities:v${FACILITY_READ_SCHEMA_VERSION}:${FACILITY_READ_PROMPT_VERSION}:${facilityReadPromptHash()}:e${FACILITY_READ_EFFORT}:${model}:${transactionId}:p${pages.join(",")}`;
}

// ---------------------------------------------------------------------------
// Wire types and parsing
// ---------------------------------------------------------------------------

export interface FacilityWire {
  name_as_printed: string;
  type: (typeof WIRE_FACILITY_TYPES)[number];
  lender: string;
  amount_drawn_text: string;
  drawn_column_heading: string;
  drawn_period_end: string;
  facility_size_text: string;
  maturity: string;
  rate_or_margin: string;
  security: string;
  ranking_text: string;
  excerpt_page: number;
}

export interface FacilityReadWire {
  note: {
    status: "found" | "abstain";
    abstain_reason: string;
    heading: string;
    header_scale_caption: string;
    header_currency: string;
    basis: SecondReadBasis;
    basis_text: string;
  };
  facilities: FacilityWire[];
}

export type FacilityReadParse = { ok: true; value: FacilityReadWire } | { ok: false; errors: string[] };

export function parseFacilityRead(raw: string): FacilityReadParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, errors: ["$: not JSON"] };
  }
  const errors = validateAgainstSchema(parsed, FACILITY_READ_SCHEMA);
  return errors.length ? { ok: false, errors } : { ok: true, value: parsed as FacilityReadWire };
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

function pageList(pages: number[]): string {
  return pages.length === 1 ? `page ${pages[0]}` : `pages ${pages.join(", ")}`;
}

// Lower case, typographic quotes folded, punctuation other than the parts of a number or a
// percentage dropped, spaces collapsed.
export function normWords(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/(\d),(\d)/g, "$1$2")
    .replace(/[^a-z0-9%.£$€'\s-]/g, " ")
    .replace(/(^|\s)['.-]+|['.-]+(?=\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^the /, "");
}

function wordSet(s: string): Set<string> {
  return new Set(normWords(s).split(" ").filter(Boolean));
}

// Words that can be dropped from one read's phrase without changing what it says. Anything else
// (super, senior, junior, secured, unsecured, fixed, floating, second, lien, not) changes the
// meaning, so a phrase that differs by one of those does not agree.
const HARMLESS = new Set([
  "a", "an", "and", "at", "by", "in", "is", "are", "of", "on", "over", "per", "which", "with", "its", "it",
  "bond", "bonds", "note", "notes", "loan", "loans", "facility", "facilities", "borrowing", "borrowings",
  "due", "maturing", "matures", "repayable", "annum", "this", "that",
]);

// Null when the two phrases say the same thing; otherwise why not. They agree when their words are
// the same (in any order), or when one's words are all in the other and every extra word is
// harmless ("senior secured" and "senior secured bond"). "senior secured" and "super senior
// secured" do not agree.
export function phraseProblem(a: string, b: string): string | null {
  const A = wordSet(a);
  const B = wordSet(b);
  if (A.size === 0 || B.size === 0) return "one read gave no words";
  const [small, big] = A.size <= B.size ? [A, B] : [B, A];
  for (const w of small) if (!big.has(w)) return `the words differ ("${a}" against "${b}")`;
  const extra = [...big].filter((w) => !small.has(w));
  const meaningful = extra.filter((w) => !HARMLESS.has(w));
  return meaningful.length === 0 ? null : `the words differ ("${a}" against "${b}")`;
}

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const NUMBER_WORDS: Record<string, string> = {
  one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", twelve: "12",
};

// The dates, years and terms a maturity prints, as a sorted list. "November 2029" and "maturing in
// November 2029" give the same list; "November 2029" and "November 2028" do not.
export function maturitySignature(s: string): string[] {
  let t = normWords(s);
  const out: string[] = [];
  const monthRe = "(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*";
  t = t.replace(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?: of)? ${monthRe} ((?:19|20)\\d{2})\\b`, "g"), (_m, d, mo, y) => {
    out.push(`${y}-${String(MONTH_NAMES.indexOf(mo) + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
    return " ";
  });
  t = t.replace(new RegExp(`\\b${monthRe} ((?:19|20)\\d{2})\\b`, "g"), (_m, mo, y) => {
    out.push(`${y}-${String(MONTH_NAMES.indexOf(mo) + 1).padStart(2, "0")}`);
    return " ";
  });
  t = t.replace(/\b(\d{1,2})[./](\d{1,2})[./]((?:19|20)\d{2})\b/g, (_m, d, mo, y) => {
    out.push(`${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
    return " ";
  });
  t = t.replace(/\b((?:19|20)\d{2})\b/g, (_m, y) => {
    out.push(y);
    return " ";
  });
  t.replace(/\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|twelve)[ -](year|month)s?\b/g, (_m, n, unit) => {
    out.push(`${NUMBER_WORDS[n] ?? n}-${unit}`);
    return " ";
  });
  if (/\bon demand\b/.test(t)) out.push("on-demand");
  return out.sort();
}

const REFERENCE_RATES = ["sonia", "sofr", "euribor", "libor", "base rate", "fixed", "floating"];

// The percentages and reference rates a rate or margin prints, as a sorted list.
export function rateSignature(s: string): string[] {
  const t = normWords(s);
  const out: string[] = [];
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(%|per cent|percent)/g)) out.push(`${Number(m[1])}%`);
  for (const r of REFERENCE_RATES) if (t.includes(r)) out.push(r);
  return out.sort();
}

const RANKING_WORDS = /\b(super senior|senior|junior|subordinated|subordinate|mezzanine|pari passu|first lien|second lien|ranks?|ranking|priority|prior ranking)\b/i;

export function statesRanking(s: string | null | undefined): boolean {
  return !!s && RANKING_WORDS.test(s);
}

// ---------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------

// A comparative written beside the figure, "(2024: £nil)" or "(2025: 12.3)", is not the figure.
function stripComparatives(s: string): string {
  return s.replace(/\(\s*(?:19|20)\d{2}\s*[:\-–]?[^)]*\)/g, " ").replace(/\s+/g, " ").trim();
}

const NIL = /^(?:£\s*)?(nil|none|undrawn|fully undrawn|-|–|—)$|\bundrawn\b/i;

export type PrintedAmount =
  | { kind: "nil"; text: string }
  | { kind: "figure"; text: string; value: number; inlineScale: number | null; inlineCurrency: string | null }
  | { kind: "several"; text: string; figures: string[] }
  | { kind: "unreadable"; text: string };

// The figures printed in an amount's words, dates and years aside. "£51.0m at 31 December 2025" has
// one; "drawn down £51.0m, leaving £21.5m undrawn" has two.
function figuresIn(s: string): string[] {
  const undated = s
    .replace(/\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(?:19|20)\d{2}\b/gi, " ")
    .replace(/\b\d{1,2}[./]\d{1,2}[./](?:19|20)\d{2}\b/g, " ")
    .replace(/(^|[^£$€\d.,])(?:19|20)\d{2}\b/g, "$1 ");
  return [...undated.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => m[0]);
}

// The amount as printed: words that say nil, or a figure with any unit and currency written beside
// it. The value comes from the printed digits; nothing is applied yet.
export function readAmount(raw: string): PrintedAmount {
  const cleaned = stripComparatives(raw.trim());
  if (!/\d/.test(cleaned) && NIL.test(cleaned)) return { kind: "nil", text: cleaned };
  // Two reads copying the same sentence agree on the sentence, not on which of its figures is the
  // amount. So words that carry more than one figure establish none.
  const figures = figuresIn(cleaned);
  if (figures.length > 1) return { kind: "several", text: cleaned, figures };
  const m = cleaned.match(/(us\$|\$|£|€|gbp|usd|eur)?\s*(\d[\d,]*(?:\.\d+)?)\s*(bn|billion|m|million|mn|k|thousand|'000|’000)?\b/i);
  if (!m) return { kind: "unreadable", text: cleaned };
  const value = Number(m[2].replace(/,/g, ""));
  if (!Number.isFinite(value)) return { kind: "unreadable", text: cleaned };
  const unit = (m[3] ?? "").toLowerCase();
  const inlineScale =
    unit === "bn" || unit === "billion" ? 1e9 : unit === "m" || unit === "million" || unit === "mn" ? 1e6 : unit ? 1e3 : null;
  const sym = (m[1] ?? "").toLowerCase();
  const inlineCurrency = sym ? currencyFromText(sym) : null;
  return { kind: "figure", text: cleaned, value, inlineScale, inlineCurrency };
}

type AmountJudgement = { ok: true; cell: FacilityCell } | { ok: false; cell: FacilityCell };

function cell(status: FacilityCell["status"], fields: Partial<FacilityCell> = {}): FacilityCell {
  return { status, text: null, pounds: null, page: null, reason: null, ...fields };
}

function judgeAmount(
  what: string,
  first: string | null,
  second: string,
  page: number | null,
  firstNoteCaption: string | null,
  secondHeaderCaption: string,
  secondHeaderCurrency: string
): FacilityCell {
  const f = (first ?? "").trim();
  const s = second.trim();
  if (!f && !s) return cell("not-printed", { page, reason: `No ${what} is printed for this facility.` });
  if (!f || !s) {
    return cell("abstain", { page, reason: `Only one read found the ${what}${f ? ` ("${f}")` : ` ("${s}")`}. ${SINGLE_READ}` });
  }
  const a = readAmount(f);
  const b = readAmount(s);
  if (a.kind === "nil" && b.kind === "nil") {
    return cell("agreed", { text: a.text, nil: true, page });
  }
  if (a.kind === "several" || b.kind === "several") {
    const w = a.kind === "several" ? a : (b as Extract<PrintedAmount, { kind: "several" }>);
    return cell("abstain", {
      page,
      reason: `The ${what} is printed in words that carry more than one figure (${w.figures.join(", ")}: "${w.text}"), so which one is the ${what} is not established from the page.`,
    });
  }
  if (a.kind !== "figure" || b.kind !== "figure") {
    return cell("abstain", { page, reason: `The two reads did not agree on the ${what}: "${f}" against "${s}".` });
  }
  // The scale: written beside the figure, or else the caption printed at the head of the note,
  // which only the second read reports from the page. Never from the size of the number.
  const header = secondHeaderCaption.trim();
  const hs = header ? scaleFromCaption(header) : null;
  const s1 = a.inlineScale ?? (hs !== null ? hs : scaleFromCaption(firstNoteCaption));
  const s2 = b.inlineScale ?? hs;
  if (s1 === null || s2 === null) {
    return cell("abstain", {
      page,
      reason: `The scale of the ${what} could not be established from the page: "${a.inlineScale === null ? f : s}" has no unit written beside it and no unit caption is printed at the head of the note, so it could be pounds, thousands or millions.`,
    });
  }
  const currency = a.inlineCurrency ?? b.inlineCurrency ?? currencyFromText(header) ?? currencyFromText(secondHeaderCurrency);
  if (currency === null) {
    return cell("abstain", { page, reason: `The currency of the ${what} could not be established from the page: "${f}" names none and the note heading states none.` });
  }
  if (currency !== "GBP") {
    return cell("abstain", { page, reason: `The ${what} is printed in ${currency} ("${f}"), and this sheet is in pounds, so it is not shown.` });
  }
  if ((a.inlineCurrency && a.inlineCurrency !== currency) || (b.inlineCurrency && b.inlineCurrency !== currency)) {
    return cell("abstain", { page, reason: `The two reads gave the ${what} in different currencies: "${f}" against "${s}".` });
  }
  const p1 = toPence(a.value * s1);
  const p2 = toPence(b.value * s2);
  if (p1 !== p2) {
    return cell("abstain", {
      page,
      reason: `The two reads disagreed on the ${what}: "${f}" is ${poundsText(p1)} and "${s}" is ${poundsText(p2)}.`,
    });
  }
  return cell("agreed", { text: a.text, pounds: p1, page });
}

// ---------------------------------------------------------------------------
// Text cells
// ---------------------------------------------------------------------------

function judgeText(
  what: string,
  first: string | null,
  second: string,
  page: number | null,
  signature?: (s: string) => string[]
): FacilityCell {
  const f = (first ?? "").trim();
  const s = second.trim();
  if (!f && !s) return cell("not-printed", { page, reason: `No ${what} is printed for this facility.` });
  if (!f || !s) {
    return cell("abstain", { page, reason: `Only one read found the ${what} ("${f || s}"). ${SINGLE_READ}` });
  }
  if (signature) {
    const a = signature(f);
    const b = signature(s);
    if (a.length > 0 || b.length > 0) {
      return a.join("|") === b.join("|")
        ? cell("agreed", { text: f, page })
        : cell("abstain", { page, reason: `The two reads disagreed on the ${what}: "${f}" against "${s}".` });
    }
  }
  const problem = phraseProblem(f, s);
  if (problem) return cell("abstain", { page, reason: `The two reads disagreed on the ${what}: ${problem}.` });
  // Both reads saw these words; show the shorter, which is what both agree the page says.
  return cell("agreed", { text: wordSet(f).size <= wordSet(s).size ? f : s, page });
}

// Ranking is shown only as the note's own words on ranking, agreed by both reads. Words that do not
// state a ranking, such as a facility's name, are "not stated", not a ranking.
function judgeRanking(first: string | null, second: string, page: number | null): FacilityCell {
  const f = (first ?? "").trim();
  const s = second.trim();
  const fStates = statesRanking(f);
  const sStates = statesRanking(s);
  if (!fStates && !sStates) {
    const why = f && !fStates ? ` The first read gave "${f}", which does not state a ranking.` : "";
    return cell("not-printed", { page, reason: `The note does not state how this facility ranks.${why}` });
  }
  if (!fStates || !sStates) {
    return cell("abstain", { page, reason: `Only one read found words on ranking ("${fStates ? f : s}"). ${SINGLE_READ}` });
  }
  const problem = phraseProblem(f, s);
  if (problem) return cell("abstain", { page, reason: `The two reads disagreed on the ranking: ${problem}.` });
  return cell("agreed", { text: wordSet(f).size <= wordSet(s).size ? f : s, page });
}

// ---------------------------------------------------------------------------
// Pairing the two lists
// ---------------------------------------------------------------------------

function nameScore(a: string | null, b: string): number {
  const A = wordSet(a ?? "");
  const B = wordSet(b);
  if (A.size === 0 || B.size === 0) return 0;
  const inter = [...A].filter((w) => B.has(w)).length;
  return inter / (A.size + B.size - inter);
}

function amountPounds(t: string | null, caption: string | null): number | null {
  if (!t) return null;
  const a = readAmount(t);
  if (a.kind !== "figure") return null;
  const s = a.inlineScale ?? scaleFromCaption(caption);
  return s === null ? null : toPence(a.value * s);
}

// How well a second-read facility matches a first-read one. Types that are both stated and differ
// never pair. An equal committed size or amount drawn is the strongest sign, then the type, then
// the name. Below 3 is no match.
function pairScore(first: Facility, second: FacilityWire, firstCaption: string | null, secondCaption: string): number {
  const t2 = second.type === "none" ? null : second.type;
  if (first.type && t2 && first.type !== t2 && first.type !== "other" && t2 !== "other") return -1;
  let score = 0;
  const c1 = amountPounds(first.facilitySizeText, firstCaption);
  const c2 = amountPounds(second.facility_size_text, secondCaption || firstCaption);
  if (c1 !== null && c1 === c2) score += 3;
  const d1 = amountPounds(first.amountDrawnText, firstCaption);
  const d2 = amountPounds(second.amount_drawn_text, secondCaption || firstCaption);
  if (d1 !== null && d1 !== 0 && d1 === d2) score += 2;
  if (first.type && t2 && first.type === t2 && t2 !== "other") score += 2;
  const n = nameScore(first.nameAsPrinted, second.name_as_printed);
  if (normWords(first.nameAsPrinted) === normWords(second.name_as_printed) && n > 0) score += 3;
  else score += 2 * n;
  return score;
}

// ---------------------------------------------------------------------------
// The whole judgement. Pure: the same read and the same second read give the same table.
// ---------------------------------------------------------------------------

export interface FacilityJudgeOptions {
  accountsType?: AccountsTypeLabel | null;
  verifierName?: string;
}

export function abstainTable(read: Pick<VisionReadResult, "transactionId">, reason: string, pages: number[] = [], verifier = FACILITY_READER_NAME): CapitalStructure {
  return {
    status: "abstain",
    reason,
    verifier,
    transactionId: read.transactionId,
    pages,
    noteHeading: null,
    scaleCaption: null,
    rows: [],
    notes: [],
    fulcrumStated: false,
  };
}

// The facilities the table considers, with the first read's index. Leases are shown as lease
// liabilities on the sheet, not as facilities, and a facility with no name cannot be paired.
function candidates(read: VisionReadResult): { f: Facility; i: number }[] {
  if (read.debtNote.status !== "found") return [];
  return read.debtNote.facilities.map((f, i) => ({ f, i })).filter(({ f }) => f.type !== "lease");
}

export function debtNotePages(read: VisionReadResult): number[] {
  if (read.debtNote.status !== "found") return [];
  const pages = new Set<number>(read.debtNote.pdfPageIndexes);
  for (const { f } of candidates(read)) if (f.pdfPageIndex) pages.add(f.pdfPageIndex);
  return [...pages].filter((p) => Number.isInteger(p) && p >= 1).sort((a, b) => a - b);
}

function basisProblem(read: VisionReadResult, wire: FacilityReadWire, why: string): string | null {
  const headings = [
    { what: "the note heading", text: wire.note.heading.trim() },
    { what: "the words the second read gave for the basis", text: wire.note.basis_text.trim() },
    ...wire.facilities
      .map((f) => f.drawn_column_heading.trim())
      .filter(Boolean)
      .map((text) => ({ what: "a column heading the amount drawn was read from", text })),
  ];
  const company = headings.find((h) => headingBasis(h.text) === "company");
  if (company) {
    return `company-only statement in a group filing: ${why}, but ${company.what} is "${company.text}", the company's own note, not the group's.`;
  }
  if (wire.note.basis === "company") {
    return `company-only statement in a group filing: ${why}, but the second read found this note in the company's own statements.`;
  }
  if (read.document.basis !== "consolidated") {
    return `company-only statement in a group filing: ${why}, but the first read took the ${read.document.basis === "company" ? "company's own" : "unstated"} statements, not the consolidated ones.`;
  }
  if (wire.note.basis !== "consolidated") {
    return `The two reads did not agree on the basis: the first read took the consolidated statements, and the second read could not tell from the page whether the note "${wire.note.heading.trim()}" is the group's or the company's.`;
  }
  if (!headings.some((h) => headingBasis(h.text) === "group")) {
    return `company-only statement in a group filing: ${why}, and nothing printed for the note "${wire.note.heading.trim()}" says "consolidated" or "group", so it could be the company's own.`;
  }
  return null;
}

export function judgeFacilities(
  read: VisionReadResult,
  wire: FacilityReadWire,
  pages: number[],
  options: FacilityJudgeOptions = {}
): CapitalStructure {
  const verifier = options.verifierName ?? FACILITY_READER_NAME;
  const where = pageList(pages);
  if (read.debtNote.status !== "found") {
    return abstainTable(read, `No debt note was read: ${read.debtNote.reason}.`, pages, verifier);
  }
  if (candidates(read).length === 0) return abstainTable(read, NO_FACILITIES, pages, verifier);
  if (wire.note.status === "abstain") {
    const why = wire.note.abstain_reason.trim();
    return abstainTable(read, `The second read found no borrowings note on ${where}${why ? ` (${why})` : ""}. A table seen by one read only is never shown.`, pages, verifier);
  }
  const groupWhy = groupFilerWhy(options.accountsType, read);
  if (groupWhy) {
    const problem = basisProblem(read, wire, groupWhy);
    if (problem) return abstainTable(read, problem, pages, verifier);
  }

  const firstCaption = read.debtNote.scaleCaption;
  const secondCaption = wire.note.header_scale_caption.trim();
  const noteHeading = wire.note.heading.trim() || null;
  const docPeriod = read.document.periodEnd;
  const notes: string[] = [];
  const all = read.debtNote.facilities;
  const leases = all.filter((f) => f.type === "lease").length;
  if (leases) notes.push(`${leases} lease line${leases === 1 ? "" : "s"} in the note ${leases === 1 ? "is" : "are"} shown as lease liabilities, not as facilities.`);

  // Pair greedily by score, best first. A first-read facility whose best score is shared by two
  // second-read facilities is ambiguous and abstains.
  const firsts = candidates(read);
  const scores = firsts.map(({ f }) => wire.facilities.map((s) => pairScore(f, s, firstCaption, secondCaption)));
  const pairs = new Map<number, number>(); // index in firsts -> index in wire.facilities
  const ambiguous = new Set<number>();
  const taken = new Set<number>();
  const order = firsts
    .map((_, i) => i)
    .sort((x, y) => Math.max(0, ...scores[y]) - Math.max(0, ...scores[x]));
  for (const i of order) {
    const row = scores[i].map((s, j) => ({ s, j })).filter(({ s, j }) => s >= 3 && !taken.has(j));
    if (row.length === 0) continue;
    const best = Math.max(...row.map((r) => r.s));
    const top = row.filter((r) => r.s === best);
    if (top.length > 1) {
      ambiguous.add(i);
      continue;
    }
    pairs.set(i, top[0].j);
    taken.add(top[0].j);
  }
  const unmatchedSecond = wire.facilities.length - taken.size;
  if (unmatchedSecond > 0) {
    notes.push(`The second read listed ${unmatchedSecond} facilit${unmatchedSecond === 1 ? "y" : "ies"} the first read did not. ${unmatchedSecond === 1 ? "It is" : "They are"} not shown, because a facility seen by one read only is never shown.`);
  }

  const rows: FacilityRow[] = firsts.map(({ f, i: idx }, i) => {
    const id = `facility-${idx + 1}`;
    const page = f.pdfPageIndex ?? null;
    const empty = (reason: string): Record<FacilityCellKey, FacilityCell> =>
      Object.fromEntries(FACILITY_CELL_KEYS.map((k) => [k, cell("abstain", { page, reason })])) as Record<FacilityCellKey, FacilityCell>;
    const abstainRow = (reason: string): FacilityRow => ({
      id,
      status: "abstain",
      name: f.nameAsPrinted,
      type: f.type,
      page,
      cells: empty(reason),
      citation: `PDF page ${page ?? "not given"}${noteHeading ? `, note "${noteHeading}"` : ""}.`,
      reason,
    });
    if (ambiguous.has(i)) {
      return abstainRow(`The second read listed more than one facility that could be "${f.nameAsPrinted ?? "this facility"}", so the two reads could not be matched. ${SINGLE_READ}`);
    }
    const j = pairs.get(i);
    if (j === undefined) {
      return abstainRow(`The second read did not list "${f.nameAsPrinted ?? "this facility"}" on ${where}. A facility seen by one read only is never shown.`);
    }
    const s = wire.facilities[j];

    let drawn = judgeAmount("amount drawn", f.amountDrawnText, s.amount_drawn_text, page, firstCaption, secondCaption, wire.note.header_currency);
    // The amount drawn is at the balance sheet date or it is not shown. A column heading decides it
    // as it does for a line (WP-BE05); an amount in a sentence needs the date the sentence gives.
    if (drawn.status === "agreed" && docPeriod) {
      const heading = s.drawn_column_heading.trim();
      const p2 = s.drawn_period_end.trim();
      const problem = heading
        ? periodFromHeading(heading, docPeriod)
        : p2 && p2 !== docPeriod
          ? `The period did not match: the second read took the amount drawn at ${p2}, but the accounts are made up to ${docPeriod}.`
          : !p2
            ? `The date of the amount drawn could not be established from the page, so it could be this year's or last year's.`
            : null;
      if (problem) drawn = cell("abstain", { page, reason: problem });
    }
    const cells: Record<FacilityCellKey, FacilityCell> = {
      drawn,
      committed: judgeAmount("committed facility size", f.facilitySizeText, s.facility_size_text, page, firstCaption, secondCaption, wire.note.header_currency),
      maturity: judgeText("maturity", f.maturity, s.maturity, page, maturitySignature),
      rateOrMargin: judgeText("rate or margin", f.rateOrMargin, s.rate_or_margin, page, rateSignature),
      security: judgeText("security", f.security, s.security, page),
      lender: judgeText("lender", f.lender, s.lender, page),
      ranking: judgeRanking(f.ranking, s.ranking_text, page),
    };
    const agreed = FACILITY_CELL_KEYS.filter((k) => cells[k].status === "agreed");
    if (agreed.length === 0) {
      const r = abstainRow(`The two reads agreed on nothing printed for "${f.nameAsPrinted ?? "this facility"}", so no part of it is shown.`);
      return { ...r, cells };
    }
    const agreedWords = agreed.map((k) => `${k} "${cells[k].text}"`).join(", ");
    return {
      id,
      status: "found",
      name: f.nameAsPrinted,
      type: f.type,
      page,
      cells,
      citation: `PDF page ${page ?? "not given"}${noteHeading ? `, note "${noteHeading}"` : ""}, "${f.nameAsPrinted ?? ""}". Read twice and agreed: ${agreedWords}.${groupWhy ? " Both reads put the note in the group accounts." : ""}`,
      reason: null,
    };
  });

  const found = rows.filter((r) => r.status === "found").length;
  return {
    status: found > 0 ? "found" : "abstain",
    reason: found > 0 ? null : `No facility in the note was agreed by both reads.`,
    verifier,
    transactionId: read.transactionId,
    pages,
    noteHeading,
    scaleCaption: secondCaption || null,
    rows,
    notes,
    fulcrumStated: false,
  };
}

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

export interface FacilityReaderDeps {
  provider?: StructuredLLMProvider | null; // default: the env-configured Anthropic provider
  cache?: Cache; // default: getCache()
  cacheOnly?: boolean; // serve a cached read or abstain; never make a model call
  maxTokens?: number;
}

export interface FacilityReadInput {
  read: VisionReadResult;
  pdfBytes: Uint8Array;
  accountsType?: AccountsTypeLabel | null;
}

export interface FacilityReadResult {
  table: CapitalStructure;
  usage: LLMUsage | null; // null when no call was made
}

export interface FacilityReader {
  readonly name: string;
  read(input: FacilityReadInput): Promise<FacilityReadResult>;
}

interface CachedFacilityRead {
  wire: FacilityReadWire;
  pages: number[];
  usage: LLMUsage | null;
}

export class DebtNoteFacilityReader implements FacilityReader {
  readonly name = FACILITY_READER_NAME;
  constructor(private readonly deps: FacilityReaderDeps = {}) {}

  async read(input: FacilityReadInput): Promise<FacilityReadResult> {
    const { read, pdfBytes } = input;
    const options: FacilityJudgeOptions = { accountsType: input.accountsType ?? null, verifierName: this.name };
    const none = (reason: string, pages: number[] = [], usage: LLMUsage | null = null): FacilityReadResult => ({
      table: abstainTable(read, reason, pages, this.name),
      usage,
    });
    if (read.debtNote.status !== "found") return none(`No debt note was read: ${read.debtNote.reason}.`);
    if (candidates(read).length === 0) return none(NO_FACILITIES);
    const pages = debtNotePages(read);
    if (pages.length === 0) return none(`The first read gave no page for the debt note, so there is nothing to read a second time.`);
    if (pages.length > FACILITY_READ_MAX_PAGES) {
      return none(`The first read gave ${pages.length} pages for the debt note, more than a borrowings note runs to, so no second read was made. ${SINGLE_READ}`, pages);
    }
    const subset = await cutPdfPages(pdfBytes, pages);
    if (!subset) return none(`No second read was made: ${pageList(pages)} could not be cut out of this PDF. ${SINGLE_READ}`, pages);

    const provider = this.deps.provider !== undefined ? this.deps.provider : getAnthropicProvider();
    const cache = this.deps.cache ?? getCache();
    const key = facilityReadCacheKey(cacheModelFor(provider), read.transactionId, subset.pages);
    const cached = await cache.get<CachedFacilityRead>(key);
    if (cached) return { table: judgeFacilities(read, cached.wire, cached.pages, options), usage: null };
    if (this.deps.cacheOnly) return none(`No second read of the debt note is held for this filing, and this run may not pay for one. ${SINGLE_READ}`, pages);
    if (!provider) return none(`No second read of the debt note was made: no model is configured. ${SINGLE_READ}`, pages);

    const sent = await provider.send({
      system: FACILITY_READ_SYSTEM_PROMPT,
      content: [
        {
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: Buffer.from(subset.bytes).toString("base64") },
        },
        { type: "text", text: facilityReadUserText(read.companyNumber, subset.pages.length) },
      ],
      maxTokens: this.deps.maxTokens ?? FACILITY_READ_MAX_TOKENS,
      outputSchema: FACILITY_READ_SCHEMA,
      effort: FACILITY_READ_EFFORT,
      label: `vision-facilities:${read.companyNumber}`,
    });
    if (!sent.ok) return none(`No second read of the debt note was made: the model call failed (${sent.failure.kind}). ${SINGLE_READ}`, pages, sent.usage);
    const parsed = parseFacilityRead(sent.text);
    if (!parsed.ok) return none(`The second read of the debt note came back in a shape that could not be checked, so it confirms nothing. ${SINGLE_READ}`, pages, sent.usage);
    await cache.set<CachedFacilityRead>(key, { wire: parsed.value, pages: subset.pages, usage: sent.usage }, FACILITY_READ_CACHE_TTL_SECONDS);
    return { table: judgeFacilities(read, parsed.value, subset.pages, options), usage: sent.usage };
  }
}

export function createFacilityReader(deps: FacilityReaderDeps = {}): FacilityReader {
  return new DebtNoteFacilityReader(deps);
}
