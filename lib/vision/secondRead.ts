// lib/vision/secondRead.ts
// The second read of a scanned filing (WP-BE05): its prompt, its output schema and the parser.
//
// The second read is not a repeat of the first. It is sent only the pages the first read cited,
// cut out of the filing as a new PDF, and it is told which line keys to look for and nothing
// else: no figure, no label, no page, no scale and no period from the first read. So it cannot
// agree by copying, and it cannot lean on context the first read had and it does not.
//
// It also reads what the checks need that the first read never returns: the unit caption at the
// head of each statement, the column heading the figure sits under, and the printed totals that
// let a balance sheet or net debt tie run.
//
// Since WP-BE18 it also says, for each line, whose statement the figure sits in (the group's or the
// company's own) and copies the printed words that say so. The first read declares one basis for
// the whole document; the second read is not told it and must find the basis on the page itself,
// so a first read that took the parent company's balance sheet cannot be agreed by copying.
//
// Since WP-BE22 it also copies, for a line whose column heading prints no year, the header rows of
// the same table that head that column (at most two), so a two-row heading such as "Year ended
// 31 December 2025" over "Post non-underlying items" can establish the period. Reads recorded
// before v3 carry no such rows; they are read as carrying none, which is what they said.
//
// Same wire rules as lib/vision/schema.ts: no nullables, every property required, "" for text
// not printed, 0 for a page not known, and the model returns figures as printed text, never as
// numbers.

import { createHash } from "node:crypto";
import { BASE_LINE_KEYS, type BaseLineKey } from "./types";
import { VISION_SYSTEM_PROMPT } from "./prompt";
import { SIGN_VALUES, validateAgainstSchema, readPrintedFigure } from "./schema";

// v3 / schema 3 (WP-BE22): the header rows over a column that prints no year.
// v4 / schema 4 (WP-BE23): the lease line keys and their definitions changed (prompt.ts p3).
export const SECOND_READ_SCHEMA_VERSION = 4;
export const SECOND_READ_PROMPT_VERSION = "v4";

// Whose statement a line sits in. "none" is the read saying it cannot tell.
export const BASIS_VALUES = ["consolidated", "company", "none"] as const;
export type SecondReadBasis = (typeof BASIS_VALUES)[number];

// Printed totals the ties need. None of them is a base line, and none of them is ever surfaced:
// a tie input read once is evidence about the base lines, not a figure for the sheet.
export const TIE_ROLES = ["total_equity", "total_liabilities", "current_assets", "borrowings_total", "net_debt"] as const;
export type TieRole = (typeof TIE_ROLES)[number];

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

const SECOND_LINE_SCHEMA = obj({
  key: oneOf(BASE_LINE_KEYS),
  status: oneOf(["found", "abstain"]),
  abstain_reason: text(),
  printed_label: text(),
  figure_text: text(),
  sign: oneOf(SIGN_VALUES),
  scale_caption: text(),
  header_scale_caption: text(),
  header_currency: text(),
  column_heading: text(),
  header_rows_above: { type: "array", items: text() },
  period_end: text(),
  excerpt_page: int(),
  statement: text(),
  basis: oneOf(BASIS_VALUES),
  basis_text: text(),
});

const TIE_LINE_SCHEMA = obj({
  role: oneOf(TIE_ROLES),
  status: oneOf(["found", "abstain"]),
  abstain_reason: text(),
  printed_label: text(),
  figure_text: text(),
  sign: oneOf(SIGN_VALUES),
  scale_caption: text(),
  column_heading: text(),
  period_end: text(),
  excerpt_page: int(),
});

export const SECOND_READ_SCHEMA: JsonSchema = obj({
  lines: { type: "array", items: SECOND_LINE_SCHEMA },
  tie_lines: { type: "array", items: TIE_LINE_SCHEMA },
});

// The first read's UK definitions, word for word, so both reads mean the same thing by a key.
// Only the definitions are shared; the rules and the task are written afresh below.
const DEFINITIONS = (() => {
  const start = VISION_SYSTEM_PROMPT.indexOf("UK definitions");
  const end = VISION_SYSTEM_PROMPT.indexOf("Debt note");
  return start >= 0 && end > start ? VISION_SYSTEM_PROMPT.slice(start, end).trim() : "";
})();

export const SECOND_READ_SYSTEM_PROMPT = `You check figures in UK statutory accounts filed at Companies House. You are given an excerpt of a filing: a few pages cut out of a longer PDF, usually scanned. Read the page images. You transcribe what is printed. You never calculate, convert or rescale.

For each line key you are asked for
1. Find the line on these pages and read the column for the latest period the statement shows. Never read a comparative column.
2. figure_text is the figure exactly as printed, brackets or minus sign included. sign is "negative" when the figure is printed in brackets or with a minus sign, otherwise "positive".
3. scale_caption is the unit caption that applies to that figure, as printed, such as "£'000", "£000", "£m" or "£".
4. header_scale_caption is the unit caption printed at the head of the statement or at the top of the column the figure sits in, copied exactly. If no caption is printed there on these pages, give "". Never take a caption from a different statement or note, and never infer one from the size of the numbers.
5. header_currency is the currency that heading states, as printed, such as "£", "GBP" or "US$", or "" if none is printed.
6. column_heading is the heading of the column you read, exactly as printed, such as "2026", "31 March 2026" or "52 weeks ended 1 January 2026". period_end is the end date of that period as YYYY-MM-DD. header_rows_above: when the column heading you read prints no year and no date, copy the header rows of the SAME table that head your column, nearest first, at most two, each exactly as printed. That is a heading printed above your column and spanning it, such as "2025" or "Group", or the period printed at the left of the table's header rows, such as "Year ended 31 December 2025" printed beside the unit captions. Never copy the title of the statement, a heading over a different column, or text from another table on the page. Give [] when the column heading prints a year or a date, or when no header row of the same table heads your column.
7. excerpt_page is the page of THIS excerpt the figure is on, where the first page of the excerpt is 1. statement is the heading of the statement or note as printed.
8. If the line is not on these pages, is unreadable or is ambiguous, set status to "abstain" with a short reason, text fields "", sign "none" and excerpt_page 0. An abstention is a correct answer. A guess is a wrong one.
9. basis says whose statement the figure sits in: "consolidated" when the statement, note or column is the group's (headed "Consolidated", "Group", or a note to the consolidated or group financial statements), "company" when it is the parent company's own (headed "Company", "Parent company", or a note to the company financial statements, or the figure sits in a column headed "Company"), and "none" if these pages do not say. basis_text is the printed words that say it, copied exactly: the statement heading, the page title such as "Notes to the consolidated financial statements", or the column heading such as "Group 2026". Give "" when nothing printed says it. Judge only from what is printed on these pages.
10. Return each requested key exactly once, and no other keys.

Printed totals (tie_lines), one entry for every role below, each role once, read from the same latest-period column
- total_equity: "Total equity", "Shareholders' funds" or "Total shareholders' funds" as printed.
- total_liabilities: "Total liabilities" as printed. Never add liabilities up.
- current_assets: the printed total of current assets.
- borrowings_total: a printed total of borrowings or loans, on the balance sheet or in a borrowings note.
- net_debt: "Net debt" or "Net funds" as printed in a net debt analysis or reconciliation.
If a total is not printed on these pages, set status to "abstain" with the reason "not-printed". Never work a total out.

${DEFINITIONS}

Answer with the JSON object only.`;

export function secondReadUserText(companyNumber: string, keys: BaseLineKey[], excerptPages: number): string {
  return `This excerpt is ${excerptPages} page${excerptPages === 1 ? "" : "s"} of the latest filed accounts for Companies House company number ${companyNumber}. Line keys to read: ${keys.join(", ")}. Read them under the rules.`;
}

export function secondReadPromptHash(): string {
  return createHash("sha256")
    .update(SECOND_READ_SYSTEM_PROMPT)
    .update(secondReadUserText("{companyNumber}", [], 0))
    .update(JSON.stringify(SECOND_READ_SCHEMA))
    .digest("hex")
    .slice(0, 12);
}

// ---------------------------------------------------------------------------
// Wire types and parsing
// ---------------------------------------------------------------------------

export interface SecondWireLine {
  key: BaseLineKey;
  status: "found" | "abstain";
  abstain_reason: string;
  printed_label: string;
  figure_text: string;
  sign: (typeof SIGN_VALUES)[number];
  scale_caption: string;
  header_scale_caption: string;
  header_currency: string;
  column_heading: string;
  header_rows_above?: string[]; // WP-BE22; absent only on a read recorded before v3
  period_end: string;
  excerpt_page: number;
  statement: string;
  basis: SecondReadBasis;
  basis_text: string;
}

export interface SecondWireTieLine {
  role: TieRole;
  status: "found" | "abstain";
  abstain_reason: string;
  printed_label: string;
  figure_text: string;
  sign: (typeof SIGN_VALUES)[number];
  scale_caption: string;
  column_heading: string;
  period_end: string;
  excerpt_page: number;
}

export interface SecondReadWire {
  lines: SecondWireLine[];
  tie_lines: SecondWireTieLine[];
}

export type SecondReadParse = { ok: true; value: SecondReadWire } | { ok: false; errors: string[] };

export function parseSecondRead(raw: string): SecondReadParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, errors: ["$: not JSON"] };
  }
  upgradeV1Lines(parsed);
  const errors = validateAgainstSchema(parsed, SECOND_READ_SCHEMA);
  if (errors.length) return { ok: false, errors };
  const value = parsed as SecondReadWire;
  const seen = new Set<string>();
  for (const l of value.lines) {
    if (seen.has(l.key)) errors.push(`$.lines: key ${l.key} returned twice`);
    seen.add(l.key);
  }
  const roles = new Set<string>();
  for (const t of value.tie_lines) {
    if (roles.has(t.role)) errors.push(`$.tie_lines: role ${t.role} returned twice`);
    roles.add(t.role);
  }
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

// A second read recorded under schema v1 (before WP-BE18) never said whose statement a line sat in.
// Its lines are read as saying "none", with no basis words, which is the truth about that answer:
// on a group filing they then fail the basis check and abstain; elsewhere nothing changes. Only a
// missing pair is filled; a line that gives either field is validated as given.
//
// A second read recorded under v1 or v2 (before WP-BE22) never copied the header rows above a
// column heading. Its lines are read as carrying none, which is the truth about that answer: a
// column heading with no year still abstains, exactly as it did when it was recorded.
function upgradeV1Lines(parsed: unknown): void {
  const lines = (parsed as { lines?: unknown })?.lines;
  if (!Array.isArray(lines)) return;
  for (const l of lines) {
    if (l && typeof l === "object" && !("basis" in l) && !("basis_text" in l)) {
      Object.assign(l, { basis: "none", basis_text: "" });
    }
    if (l && typeof l === "object" && !("header_rows_above" in l)) {
      Object.assign(l, { header_rows_above: [] });
    }
  }
}

// A printed figure from the second read, parsed the same way the first read's is: the value
// comes from the printed characters, and the sign the model claims must match them.
export function secondReadValue(figureText: string, sign: string): number | null {
  const p = readPrintedFigure(figureText);
  if (!p) return null;
  if ((p.negative ? "negative" : "positive") !== sign) return null;
  return p.negative ? -p.magnitude : p.magnitude;
}
