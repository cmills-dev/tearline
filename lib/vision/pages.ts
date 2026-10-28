// lib/vision/pages.ts
// Page-finding for large group filings (WP-BE15, audit BE-03).
//
// A group annual report runs to 200 pages or more, and the figures the sheet needs sit on fewer
// than twenty of them: the primary statements and the borrowings, lease and net debt notes. Sent
// whole, such a filing costs more than GBP 1 and takes minutes; over the PDF limits it cannot be
// sent at all. So a filing over PAGE_FINDING_ABOVE_PAGES pages, or over the PDF limit, is read in
// three steps:
//
//   1. Contents pass. A cheap model reads the first pages and returns the contents page entries
//      for the group statements and notes, and the page numbers printed on the pages it saw, so
//      a printed page number can be turned into a position in the PDF file.
//   2. Classification pass. The same model looks at every page of the group statements and notes
//      (or, when no contents page was found, at every page) in chunks, and says which of the
//      pages it was shown are which statement or note.
//   3. Subset. pdf-lib cuts those pages into a new PDF, and only that goes to the reader.
//
// Anything that goes wrong (the PDF cannot be opened or cut, no model, a failed call, output that
// does not validate, no group balance sheet or income statement found, or a cost estimate over
// the cap) is a failure with a reason. The caller abstains on every line, and the whole document
// is never sent. Nothing here reads a figure: the passes locate pages, and only the reader and
// the verifier read what is printed on them.

import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import type { StructuredLLMProvider, LLMUsage } from "../llm/types";
import { MODEL_PRICES, USD_TO_GBP } from "../llm/pricing";
import { validateAgainstSchema } from "./schema";

// A filing longer than this is page-found even when the PDF limits would allow it whole. At about
// 1,650 input tokens a scanned page, a 60-page whole read on Opus is roughly GBP 0.45; beyond
// that, page-finding is cheaper and faster than the whole document.
export const PAGE_FINDING_ABOVE_PAGES = 60;

// The page finder. Haiku is a fifth of Opus's input price and quick, and the job is to recognise
// headings, not to read figures. PAGE_FINDER_MODEL overrides it.
export const PAGE_FINDER_MODEL_DEFAULT = "claude-haiku-4-5";

export const CONTENTS_SCAN_PAGES = 12; // the contents page of a UK annual report sits in the first 12
export const CLASSIFY_CHUNK_PAGES = 30; // under Haiku's 100-page and 200k-token request limits
// Eight, not four (WP-BE18): James Fisher's whole-document fallback was seven chunks, and four at a time
// made two waves of about 7 s each. One wave covers a 240-page filing.
export const CLASSIFY_CONCURRENCY = 8;
export const RANGE_MARGIN_PAGES = 3; // either side of the range the contents page gives
// WP-BE21: the reader is also sent the page either side of each primary statement, and the page
// before the first borrowings page. On Kemble Water (23 Sep) the classifier's excerpt indexes came
// back one low, so every page sent sat one before its statement and the sheet said "not printed".
// Only pages whose printed number does not confirm their position get neighbours (selectPages).
export const STATEMENT_NEIGHBOUR_PAGES = 1;
// The notes go on past the classified range when no borrowings note was found in it and its last
// page is still group material; at most this many further chunks are classified.
export const NOTES_CONTINUATION_CHUNKS = 2;
export const SUBSET_MAX_PAGES = 22;

// Planning figures for the cost cap. Measured on the WP-BE05 reads of scanned filings: 1,607 to
// 1,718 input tokens a page (PizzaExpress, Travelodge, Boparan), rounded up.
export const INPUT_TOKENS_PER_SCANNED_PAGE = 1_750;
export const CONTENTS_OUTPUT_TOKENS = 1_500;
export const CLASSIFY_OUTPUT_TOKENS_PER_PAGE = 60;
export const READ_OUTPUT_TOKENS_ESTIMATE = 8_000; // the first read, thinking included
// The cap for one filing: page-finding plus the first read, by estimate before each step and by
// the recorded usage after it. The second read (lib/vision/verify.ts) costs GBP 0.06 to 0.15 on
// top of this and is outside this module.
export const PAGE_FINDING_COST_CAP_GBP = 0.85;

export const PAGE_FINDER_VERSION = "pf2"; // pf2 (WP-BE21): wider subset and range; old findings miss

export const PAGE_FINDING_ABSTAIN = {
  unopenable: "page-finding-pdf-unreadable",
  unconfigured: "page-finding-unconfigured",
  modelFailure: "page-finding-model-failure",
  malformed: "page-finding-malformed-output",
  notFound: "page-finding-statements-not-found",
  overCap: "page-finding-over-cost-cap",
  cacheOnly: "cache-only-no-model-call",
} as const;

// ---------------------------------------------------------------------------
// PDF handling (pdf-lib)
// ---------------------------------------------------------------------------

// Open a PDF for cutting. Null when pdf-lib cannot parse it or it is encrypted; the caller then
// abstains, because a filing that cannot be cut is never sent whole. The Companies House scans
// carry a broken cross-reference table, which pdf-lib recovers from by scanning the file.
export async function openPdf(bytes: Uint8Array): Promise<PDFDocument | null> {
  try {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true });
    if (doc.isEncrypted) return null;
    return doc.getPageCount() > 0 ? doc : null;
  } catch {
    return null;
  }
}

export interface PageSubset {
  bytes: Uint8Array;
  pages: number[]; // the ORIGINAL 1-based page indexes; page N of the subset is pages[N - 1]
}

// A new PDF holding only the given 1-based pages of `doc`, ascending, duplicates removed. Null
// when a page is out of range or pdf-lib fails.
export async function cutPages(doc: PDFDocument, wanted: number[]): Promise<PageSubset | null> {
  const count = doc.getPageCount();
  const pages = [...new Set(wanted)].sort((a, b) => a - b);
  if (pages.length === 0 || pages.some((p) => !Number.isInteger(p) || p < 1 || p > count)) return null;
  try {
    const out = await PDFDocument.create({ updateMetadata: false });
    const copied = await out.copyPages(
      doc,
      pages.map((p) => p - 1)
    );
    for (const page of copied) out.addPage(page);
    return { bytes: await out.save({ useObjectStreams: false }), pages };
  } catch {
    return null;
  }
}

// The page count as pdf-lib reads it from the page tree. Null when the file does not open.
export async function pdfPageCount(bytes: Uint8Array): Promise<number | null> {
  const doc = await openPdf(bytes);
  return doc ? doc.getPageCount() : null;
}

// Open and cut in one step, for a caller that cuts a filing once. Null when either step fails;
// the caller then abstains, because a filing that cannot be cut is never sent whole.
//
// RS-06 finding 2: this replaced lib/vision/pdfSubset.ts, a hand-written PDF parser and writer
// that the second read and the facility read used while page finding used pdf-lib. On all eleven
// UK gold scans the two agreed; on a PDF saved with object streams the hand parser gave up. One
// reader now opens every filing.
export async function cutPdfPages(bytes: Uint8Array, wanted: number[]): Promise<PageSubset | null> {
  const doc = await openPdf(bytes);
  return doc ? cutPages(doc, wanted) : null;
}

// Map a page index in a subset back to the original filing. 0 (the model's "not known") and
// anything out of range come back as 0, which the schema normaliser treats as out of range.
export function toOriginalPage(subsetPages: number[], subsetIndex: number): number {
  return Number.isInteger(subsetIndex) && subsetIndex >= 1 && subsetIndex <= subsetPages.length ? subsetPages[subsetIndex - 1] : 0;
}

// ---------------------------------------------------------------------------
// Cost estimates
// ---------------------------------------------------------------------------

export function estimateCostGbp(model: string, pages: number, outputTokens: number): number | null {
  const p = MODEL_PRICES[model];
  if (!p) return null;
  const usd = (pages * INPUT_TOKENS_PER_SCANNED_PAGE * p.inputPerMTok + outputTokens * p.outputPerMTok) / 1_000_000;
  return usd * USD_TO_GBP;
}

// The recorded cost of a set of calls. An unpriced call counts as unknown, never as free.
export function spentGbp(usages: (LLMUsage | null)[]): number | null {
  let total = 0;
  for (const u of usages) {
    if (!u) continue;
    if (u.costGbp === null) return null;
    total += u.costGbp;
  }
  return total;
}

// One usage record for several calls: tokens, time and cost summed. The model field names every
// model that was called, the reader's first.
export function sumUsage(usages: (LLMUsage | null)[], label?: string): LLMUsage | null {
  const us = usages.filter((u): u is LLMUsage => u !== null);
  if (us.length === 0) return null;
  const models = [...new Set(us.map((u) => u.model))];
  const priced = us.every((u) => u.priced && u.costUsd !== null);
  return {
    provider: us[0].provider,
    model: models.join("+"),
    inputTokens: us.reduce((s, u) => s + u.inputTokens, 0),
    outputTokens: us.reduce((s, u) => s + u.outputTokens, 0),
    cacheReadTokens: us.reduce((s, u) => s + u.cacheReadTokens, 0),
    cacheWriteTokens: us.reduce((s, u) => s + u.cacheWriteTokens, 0),
    durationMs: us.reduce((s, u) => s + u.durationMs, 0),
    attempts: us.reduce((s, u) => s + u.attempts, 0),
    costUsd: priced ? us.reduce((s, u) => s + (u.costUsd as number), 0) : null,
    costGbp: priced ? us.reduce((s, u) => s + (u.costGbp as number), 0) : null,
    priced,
    stopReason: us[us.length - 1].stopReason,
    ...(label ? { label } : {}),
  };
}

// ---------------------------------------------------------------------------
// Wire schemas. Same rules as lib/vision/schema.ts: no nullables, every property required,
// "" for text not printed and 0 for a page not known.
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

export const CONTENTS_SECTIONS = [
  "group_income_statement",
  "group_balance_sheet",
  "group_cash_flow_statement",
  "group_notes",
  "company_financial_statements",
  "borrowings_note",
  "leases_note",
  "net_debt_note",
] as const;
export type ContentsSection = (typeof CONTENTS_SECTIONS)[number];

export const CONTENTS_SCHEMA: JsonSchema = obj({
  contents_found: oneOf(["yes", "no"]),
  contents_pdf_page_index: int(),
  page_numbers: { type: "array", items: obj({ pdf_page_index: int(), printed_page_number: text() }) },
  entries: {
    type: "array",
    items: obj({ section: oneOf(CONTENTS_SECTIONS), title_as_printed: text(), printed_page: text() }),
  },
});

export const PAGE_ROLES = [
  "income_statement",
  "balance_sheet",
  "cash_flow_statement",
  "borrowings_note",
  "leases_note",
  "net_debt_note",
  "cash_flow_note",
  "other",
] as const;
export type PageRole = (typeof PAGE_ROLES)[number];
export const PAGE_BASIS = ["group", "company", "unclear"] as const;
export type PageBasis = (typeof PAGE_BASIS)[number];

export const CLASSIFY_SCHEMA: JsonSchema = obj({
  pages: {
    type: "array",
    items: obj({
      pdf_page_index: int(),
      printed_page_number: text(),
      basis: oneOf(PAGE_BASIS),
      roles: { type: "array", items: oneOf(PAGE_ROLES) },
    }),
  },
});

interface ContentsWire {
  contents_found: "yes" | "no";
  contents_pdf_page_index: number;
  page_numbers: { pdf_page_index: number; printed_page_number: string }[];
  entries: { section: ContentsSection; title_as_printed: string; printed_page: string }[];
}

interface ClassifyWire {
  pages: { pdf_page_index: number; printed_page_number: string; basis: PageBasis; roles: PageRole[] }[];
}

function parseWire<T>(raw: string, schema: JsonSchema): T | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  return validateAgainstSchema(value, schema).length === 0 ? (value as T) : null;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export const CONTENTS_SYSTEM_PROMPT = `You find pages in UK annual reports and accounts filed at Companies House. The PDF is usually a scan, so read the page images. You do not read any figures.

You are shown the first pages of a filing. Do three things.
1. Say whether one of these pages is the contents page (contents_found "yes" or "no") and give its position in this PDF as contents_pdf_page_index, where the first page of this PDF is 1. Use 0 if there is none.
2. For every page you are shown, give its position in this PDF and the page number printed on it, as printed. Use "" when no page number is printed on the page.
3. From the contents page, copy the entry for each of these sections, with its title and page number as printed. Leave a section out if the contents page does not list it.
   - group_income_statement: the consolidated or group income statement, or profit and loss account.
   - group_balance_sheet: the consolidated or group balance sheet, or statement of financial position.
   - group_cash_flow_statement: the consolidated or group cash flow statement.
   - group_notes: the first page of the notes to the consolidated or group financial statements.
   - company_financial_statements: the first page of the parent company's own financial statements, which follow the group notes. Use the company balance sheet if that is the first company statement listed.
   - borrowings_note: a note on borrowings, loans, bonds or interest-bearing liabilities, only if the contents page lists it.
   - leases_note: a note on leases, only if listed.
   - net_debt_note: a note analysing net debt, only if listed.
   If the filing is for a single company with no group, use the company's own statements for the group_ sections.

Answer with the JSON object only.`;

export const CLASSIFY_SYSTEM_PROMPT = `You find pages in UK annual reports and accounts filed at Companies House. The PDF is usually a scan, so read the page images. You do not read any figures.

You are shown some consecutive pages cut from a filing. For every page you are shown, give:
- pdf_page_index: its position in this PDF, where the first page of this PDF is 1. Every page appears once.
- printed_page_number: the page number printed on it, or "".
- basis: "group" when the page belongs to the consolidated or group statements or their notes, "company" when it belongs to the parent company's own statements or their notes, "unclear" otherwise.
- roles: every one of the following that the page carries, or ["other"] when it carries none.
  - income_statement: the primary income statement or profit and loss account itself, with turnover or revenue, operating profit and profit before tax. Not a note, not a segment table, not the statement of comprehensive income on its own.
  - balance_sheet: the primary balance sheet or statement of financial position itself. Not a note.
  - cash_flow_statement: the primary cash flow statement itself. Not a note.
  - borrowings_note: a note headed borrowings, loans, loans and borrowings, interest-bearing loans and borrowings, bank and other loans, bonds or notes, or financial liabilities, including its continuation pages, and any maturity analysis of those borrowings.
  - leases_note: a note headed leases, lease liabilities or right-of-use assets, including its continuation pages.
  - net_debt_note: a note or table analysing net debt or reconciling movements in net debt.
  - cash_flow_note: a note reconciling operating profit to cash generated from operations.
Only the statements and notes themselves count. A page of the strategic report, financial review or auditor's report that mentions borrowings is "other".

Answer with the JSON object only.`;

const contentsUserText = (pages: number) =>
  `These are the first ${pages} pages of the accounts. Find the contents page and the sections under the rules.`;
export const classifyUserText = (pages: number, from: number, to: number, total: number) =>
  `These ${pages} pages are pages ${from} to ${to} of a filing of ${total} pages, counted by position in the file. Classify each of them under the rules. Give pdf_page_index as the position in this excerpt, 1 to ${pages}: the first page you are shown is 1, whatever number is printed on it, and a page with no printed number still counts.`;

export function pageFinderPromptHash(): string {
  return createHash("sha256")
    .update(PAGE_FINDER_VERSION)
    .update(CONTENTS_SYSTEM_PROMPT)
    .update(contentsUserText(0))
    .update(JSON.stringify(CONTENTS_SCHEMA))
    .update(CLASSIFY_SYSTEM_PROMPT)
    .update(classifyUserText(0, 0, 0, 0))
    .update(JSON.stringify(CLASSIFY_SCHEMA))
    .digest("hex")
    .slice(0, 12);
}

export function pageFindingCacheKey(model: string, transactionId: string): string {
  return `vision-pages:${PAGE_FINDER_VERSION}:${pageFinderPromptHash()}:${model}:${transactionId}`;
}

// ---------------------------------------------------------------------------
// The two passes
// ---------------------------------------------------------------------------

export interface ContentsFinding {
  contentsPage: number | null; // original page index
  offset: number | null; // original page index minus printed page number, when it could be told
  entries: { section: ContentsSection; title: string; printedPage: number }[];
}

export interface ClassifiedPage {
  page: number; // original page index
  printedPage: string | null;
  basis: PageBasis;
  roles: PageRole[];
}

export interface PageFinding {
  version: string;
  finderModel: string;
  pageCount: number;
  contents: ContentsFinding;
  range: { from: number; to: number; how: "contents" | "whole-document" | "contents-then-rest" | "contents-then-notes" }; // the pages classified
  classified: ClassifiedPage[];
  moved?: { from: number; to: number; by: number }[]; // chunks whose positions were moved to match their printed numbers (WP-BE21)
  pages: number[]; // what goes to the reader, original indexes, ascending
  byRole: Partial<Record<PageRole, number[]>>;
  missing: PageRole[]; // roles looked for and not found (the income statement and balance sheet are never here: without them the finding fails)
  usage: LLMUsage | null; // every page-finding call summed
  calls: number;
}

export type PageFindingOutcome =
  | { ok: true; finding: PageFinding; fromCache: boolean }
  | { ok: false; reason: string; detail: string; usage: LLMUsage | null; calls: number };

export interface FindPagesInput {
  doc: PDFDocument;
  transactionId: string;
  companyNumber: string;
  // The reader's model and the cost cap for page-finding plus the first read. The finder checks
  // its own estimate and what it has spent against the cap before each call, and leaves room for
  // the read of the subset it will return.
  readerModel: string;
  costCapGbp?: number;
}

export interface FindPagesDeps {
  finder: StructuredLLMProvider;
  concurrency?: number;
}

const printedNumber = (s: string): number | null => {
  const m = s.trim().match(/^(\d{1,4})$/);
  return m ? Number(m[1]) : null;
};

// The most common difference between a page's position in the file and its printed number, over
// the pages where both are known. Null when no printed number was read.
export function pageOffset(pairs: { page: number; printed: number | null }[]): number | null {
  const counts = new Map<number, number>();
  for (const p of pairs) {
    if (p.printed === null) continue;
    const d = p.page - p.printed;
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  let best: number | null = null;
  let bestCount = 0;
  for (const [d, c] of counts) {
    if (c > bestCount || (c === bestCount && best !== null && Math.abs(d) < Math.abs(best))) {
      best = d;
      bestCount = c;
    }
  }
  return best;
}

// The pages to classify, from the contents entries: from the first group statement to the last
// page before the company statements, widened by the margin. Null when the contents page does not
// give the statements.
//
// The company statements end the group notes only when they come after the first page of those
// notes (WP-BE21). Many groups print the company balance sheet beside the group's, before any
// note: Kemble Water lists it at printed 42 with the group notes at 67, Zenith at 66 with notes at
// 69, Cath Kidston at 16 with notes at 20. Taking that entry as the end stopped each range a few
// pages into the notes, so no debt note was ever classified.
export function rangeFromContents(c: ContentsFinding, pageCount: number): { from: number; to: number } | null {
  const at = (s: ContentsSection) => c.entries.filter((e) => e.section === s).map((e) => e.printedPage);
  const statements = [...at("group_income_statement"), ...at("group_balance_sheet"), ...at("group_cash_flow_statement")];
  if (statements.length === 0) return null;
  const notes = at("group_notes");
  const debtNotes = [...at("borrowings_note"), ...at("leases_note"), ...at("net_debt_note")];
  const start = Math.min(...statements, ...notes);
  const notesStart = notes.length ? Math.min(...notes) : start;
  const afterNotes = at("company_financial_statements").filter((p) => p > notesStart);
  // Without an end, assume the notes run 100 printed pages from the first statement.
  let end = afterNotes.length ? Math.min(...afterNotes) - 1 : start + 100;
  end = Math.max(end, ...statements, ...notes, ...debtNotes);
  // With no printed numbers read, the position of a printed page is not known; take the pages a
  // scan's cover sheets usually add (0 to 6) as extra margin rather than guess.
  const lowOffset = c.offset ?? 0;
  const highOffset = c.offset ?? 6;
  const from = Math.max(1, start + lowOffset - RANGE_MARGIN_PAGES);
  const to = Math.min(pageCount, end + highOffset + RANGE_MARGIN_PAGES);
  return from <= to ? { from, to } : null;
}

// The most common difference between where the classifier put a page and where its printed number
// says it is (printed number plus the contents offset), over the pages of one chunk that print a
// number. Null when fewer than RECONCILE_MIN_PAGES print one, or no difference covers
// RECONCILE_MIN_SHARE of them.
export const RECONCILE_MIN_PAGES = 5;
export const RECONCILE_MIN_SHARE = 0.6;
export function chunkDrift(pages: ClassifiedPage[], offset: number): number | null {
  const deltas = pages.flatMap((p) => {
    const n = p.printedPage === null ? null : printedNumber(p.printedPage);
    return n === null ? [] : [p.page - (n + offset)];
  });
  if (deltas.length < RECONCILE_MIN_PAGES) return null;
  const counts = new Map<number, number>();
  for (const d of deltas) counts.set(d, (counts.get(d) ?? 0) + 1);
  const [best, count] = [...counts.entries()].sort((a, b) => b[1] - a[1] || Math.abs(a[0]) - Math.abs(b[0]))[0];
  return count / deltas.length >= RECONCILE_MIN_SHARE ? best : null;
}

// WP-BE21. The classifier is told a chunk "is pages 37 to 66 of a filing" and asked for each page's
// position in the excerpt. When a printed "37" sits near the top of the chunk it can count by the
// printed numbers instead, and every position comes back one out: on Kemble Water it put the
// income statement (PDF 40, printed 39) at position 3, not 4, twice in five runs. The printed
// numbers it gives are still right. So a chunk whose positions disagree with its printed numbers
// by the same amount, while the other chunks agree with them, is moved back by that amount. With
// no other chunk to compare against, nothing is moved: the offset could have changed between the
// front pages and the accounts, and the neighbour pages in selectPages cover a slip of one.
// `earlier` is pages classified by an earlier call, compared against but never moved.
export function reconcileChunks(
  chunks: ClassifiedPage[][],
  offset: number | null,
  earlier: ClassifiedPage[] = []
): { chunks: ClassifiedPage[][]; moved: { from: number; to: number; by: number }[] } {
  const moved: { from: number; to: number; by: number }[] = [];
  if (offset === null || chunks.length + (earlier.length ? 1 : 0) < 2) return { chunks, moved };
  const out = chunks.map((chunk, i) => {
    const drift = chunkDrift(chunk, offset);
    if (drift === null || drift === 0 || Math.abs(drift) > 2) return chunk;
    const others = [...chunks.filter((_, j) => j !== i).flat(), ...earlier];
    if (chunkDrift(others, offset) !== 0) return chunk;
    const span = new Set(chunk.map((p) => p.page));
    const lo = Math.min(...span);
    const hi = Math.max(...span);
    moved.push({ from: lo, to: hi, by: -drift });
    // A page moved off the end of the chunk belongs to the next chunk, which classified it itself.
    return chunk.map((p) => ({ ...p, page: p.page - drift })).filter((p) => p.page >= lo && p.page <= hi);
  });
  return { chunks: out, moved };
}

// Which of the classified pages go to the reader. Group pages are preferred over company pages
// for the primary statements; a note page whose basis is unclear is kept. Null when there is no
// balance sheet or no income statement: then the finding has failed.
export function selectPages(
  classified: ClassifiedPage[],
  offset: number | null = null
): { pages: number[]; byRole: Partial<Record<PageRole, number[]>>; missing: PageRole[] } | null {
  const want: { role: PageRole; max: number; statement: boolean }[] = [
    { role: "income_statement", max: 2, statement: true },
    { role: "balance_sheet", max: 2, statement: true },
    { role: "cash_flow_statement", max: 2, statement: true },
    { role: "borrowings_note", max: 4, statement: false },
    { role: "leases_note", max: 3, statement: false },
    { role: "net_debt_note", max: 2, statement: false },
    { role: "cash_flow_note", max: 2, statement: false },
  ];
  const byRole: Partial<Record<PageRole, number[]>> = {};
  const missing: PageRole[] = [];
  for (const w of want) {
    const carrying = classified.filter((p) => p.roles.includes(w.role));
    const group = carrying.filter((p) => p.basis === "group");
    const notCompany = carrying.filter((p) => p.basis !== "company");
    // Statements: group pages when there are any, else unclear, else company (a filing with no
    // group). Notes: never the company's own notes when group or unclear pages exist.
    const pool = w.statement
      ? group.length
        ? group
        : notCompany.length
          ? notCompany
          : carrying
      : notCompany.length
        ? notCompany
        : carrying;
    const chosen = pool.slice(0, w.max).map((p) => p.page);
    if (chosen.length) byRole[w.role] = chosen;
    else missing.push(w.role);
  }
  if (!byRole.income_statement || !byRole.balance_sheet) return null;

  // A debt note often runs onto a page the classifier did not mark; take the page after the last
  // borrowings page too, when it was classified at all.
  const known = new Set(classified.map((p) => p.page));
  const borrowings = byRole.borrowings_note ?? [];
  if (borrowings.length) {
    const next = Math.max(...borrowings) + 1;
    if (known.has(next)) byRole.borrowings_note = [...borrowings, next].slice(0, 5);
  }

  // The classifier's position for a page can be one out (WP-BE21). A page whose printed number,
  // plus the offset the contents pass read, lands on the position given is confirmed. For any
  // other primary statement page, the page either side goes too, and for an unconfirmed first
  // borrowings page the page before it, when classified at all. They go after the statements and
  // before the notes: a statement one page away is worth more than a third lease page. The reader
  // cites the page a figure is printed on, so a neighbour that holds nothing costs tokens, never a
  // figure. Confirmed pages get no neighbours: sending them blind cost about 9 s on James Fisher,
  // which would take its recorded 84.6 s past 90.
  const byPage = new Map(classified.map((p) => [p.page, p]));
  const confirmed = (page: number): boolean => {
    const c = byPage.get(page);
    const n = c?.printedPage ? printedNumber(c.printedPage) : null;
    return offset !== null && n !== null && n + offset === page;
  };
  const statementPages = [...(byRole.income_statement ?? []), ...(byRole.balance_sheet ?? []), ...(byRole.cash_flow_statement ?? [])];
  const neighbours: number[] = [];
  for (const p of statementPages.filter((x) => !confirmed(x))) {
    for (let d = 1; d <= STATEMENT_NEIGHBOUR_PAGES; d++) neighbours.push(p - d, p + d);
  }
  if (borrowings.length && !confirmed(Math.min(...borrowings))) neighbours.push(Math.min(...borrowings) - 1);

  const pages: number[] = [];
  const add = (p: number) => {
    if (!pages.includes(p) && pages.length < SUBSET_MAX_PAGES) pages.push(p);
  };
  for (const w of want.filter((x) => x.statement)) for (const p of byRole[w.role] ?? []) add(p);
  for (const p of neighbours) if (known.has(p)) add(p);
  for (const w of want.filter((x) => !x.statement)) for (const p of byRole[w.role] ?? []) add(p);
  return { pages: pages.sort((a, b) => a - b), byRole, missing };
}

async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

export async function findPages(input: FindPagesInput, deps: FindPagesDeps): Promise<PageFindingOutcome> {
  const { doc } = input;
  const finder = deps.finder;
  const pageCount = doc.getPageCount();
  const cap = input.costCapGbp ?? PAGE_FINDING_COST_CAP_GBP;
  const usages: LLMUsage[] = [];
  let calls = 0;
  const fail = (reason: string, detail: string): PageFindingOutcome => ({ ok: false, reason, detail, usage: sumUsage(usages), calls });

  // What the read of the subset will cost at most, kept back from the cap throughout.
  const readReserve = estimateCostGbp(input.readerModel, SUBSET_MAX_PAGES, READ_OUTPUT_TOKENS_ESTIMATE);
  if (readReserve === null) return fail(PAGE_FINDING_ABSTAIN.overCap, `the reader model ${input.readerModel} has no price, so the cap cannot be kept`);
  const withinCap = (pages: number, outputTokens: number): string | null => {
    const next = estimateCostGbp(finder.model, pages, outputTokens);
    const spent = spentGbp(usages);
    if (next === null || spent === null) return `the page finder ${finder.model} has no price, so the cap cannot be kept`;
    const total = spent + next + readReserve;
    return total > cap ? `estimated GBP ${total.toFixed(2)} (spent ${spent.toFixed(2)}, next ${next.toFixed(2)}, read ${readReserve.toFixed(2)}) is over the GBP ${cap.toFixed(2)} cap` : null;
  };

  // --- Pass 1: the contents page -------------------------------------------------------------
  const head = Array.from({ length: Math.min(CONTENTS_SCAN_PAGES, pageCount) }, (_, i) => i + 1);
  const over1 = withinCap(head.length, CONTENTS_OUTPUT_TOKENS);
  if (over1) return fail(PAGE_FINDING_ABSTAIN.overCap, over1);
  const headPdf = await cutPages(doc, head);
  if (!headPdf) return fail(PAGE_FINDING_ABSTAIN.unopenable, "the first pages could not be cut out of this PDF");
  calls++;
  const sent1 = await finder.send({
    system: CONTENTS_SYSTEM_PROMPT,
    content: [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: Buffer.from(headPdf.bytes).toString("base64") } },
      { type: "text", text: contentsUserText(head.length) },
    ],
    maxTokens: 4_000,
    outputSchema: CONTENTS_SCHEMA,
    label: `vision-pages:contents:${input.companyNumber}`,
  });
  if (sent1.usage) usages.push(sent1.usage);
  if (!sent1.ok) return fail(PAGE_FINDING_ABSTAIN.modelFailure, `contents pass: ${sent1.failure.kind}`);
  const wire1 = parseWire<ContentsWire>(sent1.text, CONTENTS_SCHEMA);
  if (!wire1) return fail(PAGE_FINDING_ABSTAIN.malformed, "contents pass: the output did not validate");

  const contents: ContentsFinding = {
    contentsPage:
      wire1.contents_found === "yes" && wire1.contents_pdf_page_index >= 1 && wire1.contents_pdf_page_index <= head.length
        ? wire1.contents_pdf_page_index
        : null,
    offset: pageOffset(
      wire1.page_numbers
        .filter((p) => p.pdf_page_index >= 1 && p.pdf_page_index <= head.length)
        .map((p) => ({ page: p.pdf_page_index, printed: printedNumber(p.printed_page_number) }))
    ),
    entries: wire1.entries.flatMap((e) => {
      const n = printedNumber(e.printed_page);
      return n === null ? [] : [{ section: e.section, title: e.title_as_printed, printedPage: n }];
    }),
  };

  // --- Pass 2: classify the pages ------------------------------------------------------------
  // The contents range when the contents page gave the statements; otherwise, or when the
  // statements were not in that range, every page not yet classified, if the cap allows it.
  const classifyPages = async (wanted: number[]): Promise<{ ok: true; pages: ClassifiedPage[] } | { ok: false; reason: string; detail: string }> => {
    // Chunks of consecutive pages only, so "pages X to Y" in the request is true of every chunk.
    const chunks: number[][] = [];
    for (const page of wanted) {
      const last = chunks[chunks.length - 1];
      if (last && last.length < CLASSIFY_CHUNK_PAGES && last[last.length - 1] === page - 1) last.push(page);
      else chunks.push([page]);
    }
    const results = await inBatches(chunks, deps.concurrency ?? CLASSIFY_CONCURRENCY, async (chunk) => {
      const span = `pages ${chunk[0]} to ${chunk[chunk.length - 1]}`;
      const cut = await cutPages(doc, chunk);
      if (!cut) return { ok: false as const, reason: PAGE_FINDING_ABSTAIN.unopenable, detail: `${span} could not be cut out of this PDF` };
      calls++;
      const sent = await finder.send({
        system: CLASSIFY_SYSTEM_PROMPT,
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: Buffer.from(cut.bytes).toString("base64") } },
          { type: "text", text: classifyUserText(chunk.length, chunk[0], chunk[chunk.length - 1], pageCount) },
        ],
        maxTokens: 8_000,
        outputSchema: CLASSIFY_SCHEMA,
        label: `vision-pages:classify:${input.companyNumber}:${chunk[0]}`,
      });
      if (sent.usage) usages.push(sent.usage);
      if (!sent.ok) return { ok: false as const, reason: PAGE_FINDING_ABSTAIN.modelFailure, detail: `classification of ${span}: ${sent.failure.kind}` };
      const wire = parseWire<ClassifyWire>(sent.text, CLASSIFY_SCHEMA);
      if (!wire) return { ok: false as const, reason: PAGE_FINDING_ABSTAIN.malformed, detail: `classification of ${span}: the output did not validate` };
      const pages: ClassifiedPage[] = [];
      const seen = new Set<number>();
      for (const p of wire.pages) {
        const original = toOriginalPage(cut.pages, p.pdf_page_index);
        if (!original || seen.has(original)) continue; // an index outside the excerpt, or a repeat, is dropped
        seen.add(original);
        pages.push({
          page: original,
          printedPage: p.printed_page_number.trim() || null,
          basis: p.basis,
          roles: p.roles.length ? [...new Set(p.roles)] : ["other"],
        });
      }
      return { ok: true as const, pages };
    });
    const failed = results.find((r) => !r.ok);
    if (failed && !failed.ok) return failed;
    const reconciled = reconcileChunks(
      results.map((r) => (r.ok ? r.pages : [])),
      contents.offset,
      classified
    );
    moved.push(...reconciled.moved);
    return { ok: true, pages: reconciled.chunks.flat() };
  };

  const pagesFrom = (from: number, to: number) => Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);
  const fromContents = contents.contentsPage !== null ? rangeFromContents(contents, pageCount) : null;
  let how: PageFinding["range"]["how"] = fromContents ? "contents" : "whole-document";
  let wanted = fromContents ? pagesFrom(fromContents.from, fromContents.to) : pagesFrom(head.length + 1, pageCount);
  const classified: ClassifiedPage[] = [];
  const moved: { from: number; to: number; by: number }[] = [];
  let selected: ReturnType<typeof selectPages> = null;
  for (let attempt = 0; attempt < 2 && wanted.length > 0; attempt++) {
    const over = withinCap(wanted.length, wanted.length * CLASSIFY_OUTPUT_TOKENS_PER_PAGE);
    if (over) return fail(PAGE_FINDING_ABSTAIN.overCap, `classification of ${wanted.length} pages (${how}): ${over}`);
    const got = await classifyPages(wanted);
    if (!got.ok) return fail(got.reason, got.detail);
    classified.push(...got.pages);
    classified.sort((a, b) => a.page - b.page);
    selected = selectPages(classified, contents.offset);
    if (selected || how !== "contents") break;
    // The contents page pointed somewhere the statements were not. Look at the rest.
    const done = new Set(classified.map((p) => p.page));
    wanted = pagesFrom(head.length + 1, pageCount).filter((p) => !done.has(p));
    how = "contents-then-rest";
  }
  if (!selected) {
    return fail(PAGE_FINDING_ABSTAIN.notFound, `no group income statement and balance sheet among the ${classified.length} pages classified (${how})`);
  }

  // WP-BE21: the contents range can end inside the notes. Southern Water's contents page lists no
  // company statements, yet the contents pass returned one at printed 202, seven pages into notes
  // that run to 233. When no borrowings note was found and the last page classified is still not
  // the company's own, classify onward a chunk at a time. A failure or the cap here keeps the
  // statements already found; it never fails the finding.
  for (let k = 0; k < NOTES_CONTINUATION_CHUNKS && !selected.byRole.borrowings_note; k++) {
    const last = classified[classified.length - 1];
    if (!last || last.basis === "company" || last.page >= pageCount) break;
    const done = new Set(classified.map((p) => p.page));
    const next = pagesFrom(last.page + 1, Math.min(pageCount, last.page + CLASSIFY_CHUNK_PAGES)).filter((p) => !done.has(p));
    if (next.length === 0 || withinCap(next.length, next.length * CLASSIFY_OUTPUT_TOKENS_PER_PAGE)) break;
    const got = await classifyPages(next);
    if (!got.ok) break;
    classified.push(...got.pages);
    classified.sort((a, b) => a.page - b.page);
    selected = selectPages(classified, contents.offset) ?? selected;
    how = how === "contents" ? "contents-then-notes" : how;
  }

  const looked = classified.map((p) => p.page);
  return {
    ok: true,
    fromCache: false,
    finding: {
      version: PAGE_FINDER_VERSION,
      finderModel: finder.model,
      pageCount,
      contents,
      range: { from: Math.min(...looked), to: Math.max(...looked), how },
      classified,
      ...(moved.length ? { moved } : {}),
      pages: selected.pages,
      byRole: selected.byRole,
      missing: selected.missing,
      usage: sumUsage(usages, `vision-pages:${input.companyNumber}`),
      calls,
    },
  };
}
