// test/pageFinding.test.ts
// Page-finding for large group filings (WP-BE15): the contents and classification passes, the
// pdf-lib subset, the read of only those pages with every citation mapped back to the original
// filing, the double read on the same pages, the cache, the cost cap, and every way it can fail
// abstaining without the whole document ever being sent.
//
// No network and no live model call. The finder, reader and second reader are scripted
// providers answering from the real layout of the three frozen scans (contents page, printed
// page offset and the pages each statement and note sits on), which was read off the page images
// on 22 Sep 2026 with a local OCR pass and by eye. They stand in for recordings: the live
// recording on 22 Sep failed on the API credit balance (test/fixtures/vision/pages/00445790.json
// holds that attempt), so the suite below also replays any recording in
// test/fixtures/vision/pages/ that test/record/largeFilings.ts has since written.

import { existsSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { PDFDocument, PDFDict, PDFName, PDFRawStream } from "pdf-lib";
import { suite, test, assert, assertEqual } from "./harness";
import { InMemoryCache } from "../lib/cache/cache";
import { AnthropicProvider } from "../lib/llm/providers/anthropic";
import type { LLMCallResult, LLMRequest, LLMUsage, StructuredLLMProvider } from "../lib/llm/types";
import { readScannedAccounts, excerptUserText, scopeToPagesRead, type PagedVisionReadResult } from "../lib/vision/client";
import {
  CLASSIFY_SCHEMA,
  CONTENTS_SCHEMA,
  PAGE_FINDING_ABOVE_PAGES,
  PAGE_FINDING_COST_CAP_GBP,
  SUBSET_MAX_PAGES,
  cutPages,
  estimateCostGbp,
  openPdf,
  pdfPageCount,
  pageOffset,
  rangeFromContents,
  selectPages,
  toOriginalPage,
  CONTENTS_SCAN_PAGES,
  READ_OUTPUT_TOKENS_ESTIMATE,
  CONTENTS_OUTPUT_TOKENS,
  CLASSIFY_OUTPUT_TOKENS_PER_PAGE,
  chunkDrift,
  findPages,
  reconcileChunks,
  type ClassifiedPage,
  type ContentsFinding,
  type ContentsSection,
  type PageRole,
} from "../lib/vision/pages";
import { VISION_SCHEMA, type VisionWireOutput, type WireLine } from "../lib/vision/schema";
import { SECOND_READ_SCHEMA, TIE_ROLES, type SecondReadWire } from "../lib/vision/secondRead";
import { DoubleReadVerifier, applyVerification } from "../lib/vision/verify";
import { visionLines } from "../lib/sources/visionAccounts";
import { BASE_LINE_KEYS, type BaseLineKey, type FoundLine } from "../lib/vision/types";
import { LARGE_FILINGS, stageOf, type LargeFiling } from "./pageFindingCases";

const here = dirname(fileURLToPath(import.meta.url));
const GOLD = join(here, "..", "eval", "gold", "fixtures", "uk");
const RECORDINGS = join(here, "fixtures", "vision", "pages");

// ---------------------------------------------------------------------------
// The real layout of the three scans
// ---------------------------------------------------------------------------
//
// Every page below was checked on 22 Sep 2026 against a local tesseract pass over the page
// images (and the contents pages by eye): the heading printed on that PDF page is the statement
// or note named. Figures: Tesco's are printed on those pages and equal the ESEF tags in the gold
// set (Revenue 73,712 on page 123, cash 2,515 on page 125, operating profit 2,985); Topps' and
// James Fisher's revenue lines are as printed on their income statements. The gold set has no
// keyed figures for Topps or James Fisher yet (WP-BE17).

interface Layout {
  contentsPage: number; // PDF page index of the contents page
  offset: number; // PDF page index minus printed page number, in the statements
  entries: { section: ContentsSection; title: string; printedPage: number }[];
  pages: { page: number; basis: "group" | "company"; roles: PageRole[] }[]; // original PDF indexes
  periodEnd: string;
  scale: string;
  // Figures printed on the primary statements, for the scripted reader, and what the gold set
  // (Tesco: the ESEF tags of the same year) says each one is in pounds.
  figures: { key: BaseLineKey; label: string; text: string; page: number; pounds: number | null }[];
}

const LAYOUT: Record<string, Layout> = {
  // Tesco PLC, Annual Report 2026. Contents on PDF page 6 (printed 04). Printed numbers run two
  // behind the PDF index. The net debt note is not listed here: it was not located by the check.
  "00445790": {
    contentsPage: 6,
    offset: 2,
    entries: [
      { section: "group_income_statement", title: "Group income statement", printedPage: 121 },
      { section: "group_balance_sheet", title: "Group balance sheet", printedPage: 123 },
      { section: "group_cash_flow_statement", title: "Group cash flow statement", printedPage: 126 },
      { section: "group_notes", title: "Notes to the Group financial statements", printedPage: 127 },
      { section: "company_financial_statements", title: "Tesco PLC - Parent Company balance sheet", printedPage: 200 },
    ],
    pages: [
      { page: 123, basis: "group", roles: ["income_statement"] },
      { page: 125, basis: "group", roles: ["balance_sheet"] },
      { page: 128, basis: "group", roles: ["cash_flow_statement"] },
      { page: 147, basis: "group", roles: ["leases_note"] }, // Note 13 Leases
      { page: 148, basis: "group", roles: ["leases_note"] },
      { page: 158, basis: "group", roles: ["borrowings_note"] }, // Note 22 Borrowings
      { page: 202, basis: "company", roles: ["balance_sheet"] }, // Parent Company balance sheet, printed 200
    ],
    periodEnd: "2026-02-28",
    scale: "£m",
    figures: [
      { key: "turnover", label: "Revenue", text: "73,712", page: 123, pounds: 73_712_000_000 },
      { key: "operating_profit", label: "Operating profit", text: "2,985", page: 123, pounds: 2_985_000_000 },
      { key: "cash_at_bank", label: "Cash and cash equivalents", text: "2,515", page: 125, pounds: 2_515_000_000 },
    ],
  },
  // Topps Tiles Plc, 52 weeks to 27 Sep 2025. Contents on PDF page 2; "Highlights 2" is PDF page 4.
  "03213782": {
    contentsPage: 2,
    offset: 2,
    entries: [
      { section: "group_income_statement", title: "Consolidated Statement of Profit or Loss", printedPage: 148 },
      { section: "group_balance_sheet", title: "Consolidated Statement of Financial Position", printedPage: 149 },
      { section: "group_cash_flow_statement", title: "Consolidated Cash Flow Statement", printedPage: 151 },
      { section: "group_notes", title: "Notes to the Financial Statements", printedPage: 152 },
      { section: "company_financial_statements", title: "Company Balance Sheet", printedPage: 193 },
    ],
    pages: [
      { page: 150, basis: "group", roles: ["income_statement"] },
      { page: 151, basis: "group", roles: ["balance_sheet"] },
      { page: 153, basis: "group", roles: ["cash_flow_statement"] },
      { page: 176, basis: "group", roles: ["leases_note"] }, // 14 Leases, runs to 179
      { page: 177, basis: "group", roles: ["leases_note"] },
      { page: 182, basis: "group", roles: ["borrowings_note"] }, // 19 Bank Loans
      { page: 183, basis: "group", roles: ["borrowings_note", "net_debt_note"] },
      { page: 195, basis: "company", roles: ["balance_sheet"] }, // Company Balance Sheet, printed 193
    ],
    periodEnd: "2025-09-27",
    scale: "£000",
    figures: [{ key: "turnover", label: "Group revenue", text: "295,754", page: 150, pounds: 295_754_000 }],
  },
  // James Fisher and Sons plc, 2025. Contents on PDF page 3, scanned upside down; PDF page 6 is
  // printed 04.
  "00211475": {
    contentsPage: 3,
    offset: 2,
    entries: [
      { section: "group_income_statement", title: "Consolidated income statement", printedPage: 122 },
      { section: "group_balance_sheet", title: "Consolidated statement of financial position", printedPage: 124 },
      { section: "group_cash_flow_statement", title: "Consolidated cash flow statement", printedPage: 126 },
      { section: "group_notes", title: "Notes to the consolidated financial statements", printedPage: 128 },
    ],
    pages: [
      { page: 124, basis: "group", roles: ["income_statement"] },
      { page: 126, basis: "group", roles: ["balance_sheet"] },
      { page: 128, basis: "group", roles: ["cash_flow_statement"] },
      { page: 166, basis: "group", roles: ["leases_note"] }, // 16. Right-of-use assets and leases
      { page: 167, basis: "group", roles: ["leases_note"] },
      { page: 170, basis: "group", roles: ["borrowings_note"] }, // 25. Borrowings
      { page: 171, basis: "group", roles: ["borrowings_note"] },
    ],
    periodEnd: "2025-12-31",
    scale: "£m",
    figures: [{ key: "turnover", label: "Revenue", text: "394.4", page: 124, pounds: 394_400_000 }],
  },
};

// ---------------------------------------------------------------------------
// Scripted providers
// ---------------------------------------------------------------------------

const usage = (model: string, pages: number, output: number): LLMUsage => {
  const gbp = estimateCostGbp(model, pages, output) ?? 0;
  return {
    provider: "script",
    model,
    inputTokens: pages * 1_650,
    outputTokens: output,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    durationMs: 1_000,
    attempts: 1,
    costUsd: gbp / 0.8,
    costGbp: gbp,
    priced: true,
    stopReason: "end_turn",
  };
};

const docPages = async (req: LLMRequest): Promise<number> => {
  const block = (req.content as any[]).find((b) => b.type === "document");
  return block ? (await pdfPageCount(new Uint8Array(Buffer.from(block.source.data, "base64")))) ?? -1 : 0;
};

class Script implements StructuredLLMProvider {
  readonly name = "script";
  calls: { stage: string; pages: number; bytes: number; req: LLMRequest }[] = [];
  constructor(
    readonly model: string,
    private readonly answer: (stage: string, req: LLMRequest) => LLMCallResult | object
  ) {}
  async complete(): Promise<string> {
    throw new Error("not used");
  }
  async send(req: LLMRequest): Promise<LLMCallResult> {
    const stage = stageOf({ system: req.system, messages: [{ content: req.content }] });
    const block = (req.content as any[]).find((b) => b.type === "document");
    const pages = await docPages(req);
    this.calls.push({ stage, pages, bytes: block ? Buffer.from(block.source.data, "base64").length : 0, req });
    const a = this.answer(stage, req);
    if ("ok" in a) return a as LLMCallResult;
    return { ok: true, text: JSON.stringify(a), stopReason: "end_turn", usage: usage(this.model, pages, 500) };
  }
}

// A finder that answers from the layout: the contents page from the first pages, and each
// classification chunk page by page.
function layoutFinder(layout: Layout, over: { contents?: (a: any) => void; classify?: (a: any, from: number, to: number) => void } = {}): Script {
  return new Script("claude-haiku-4-5", (stage) => {
    if (stage === "contents") {
      const a = {
        contents_found: "yes",
        contents_pdf_page_index: layout.contentsPage,
        page_numbers: Array.from({ length: CONTENTS_SCAN_PAGES }, (_, i) => i + 1)
          .filter((p) => p > layout.contentsPage)
          .map((p) => ({ pdf_page_index: p, printed_page_number: String(p - layout.offset) })),
        entries: layout.entries.map((e) => ({ section: e.section, title_as_printed: e.title, printed_page: String(e.printedPage) })),
      };
      over.contents?.(a);
      return a;
    }
    const m = stage.match(/^classify:(\d+)-(\d+)$/);
    if (!m) throw new Error(`finder asked an unexpected stage ${stage}`);
    const from = Number(m[1]);
    const to = Number(m[2]);
    const a = {
      pages: Array.from({ length: to - from + 1 }, (_, i) => {
        const page = from + i;
        const known = layout.pages.find((p) => p.page === page);
        return {
          pdf_page_index: i + 1,
          printed_page_number: String(page - layout.offset),
          basis: known?.basis ?? "group",
          roles: known?.roles ?? ["other"],
        };
      }),
    };
    over.classify?.(a, from, to);
    return a;
  });
}

function abstainWire(key: BaseLineKey): WireLine {
  return {
    key,
    status: "abstain",
    abstain_reason: "not-printed",
    printed_label: "",
    figure_text: "",
    sign: "none",
    scale_caption: "",
    pdf_page_index: 0,
    printed_page_number: "",
    statement: "",
    period_end: "",
    note_reference: "",
  };
}

// A reader that reads the layout's figures off whichever subset it is sent, giving each figure's
// page as its position IN THE SUBSET, as the prompt asks.
function layoutReader(layout: Layout, subsetPages: () => number[]): (req: LLMRequest) => VisionWireOutput {
  return () => {
    const pages = subsetPages();
    const w: VisionWireOutput = {
      document: { company_name_as_printed: "EXAMPLE PLC", period_end: layout.periodEnd, currency: "GBP", basis: "consolidated" },
      lines: BASE_LINE_KEYS.map(abstainWire),
      debt_note: {
        status: "found",
        abstain_reason: "",
        scale_caption: layout.scale,
        pdf_page_indexes: layout.pages.filter((p) => p.roles.includes("borrowings_note")).map((p) => pages.indexOf(p.page) + 1),
        facilities: [
          {
            name_as_printed: "Bonds",
            type: "notes_or_bonds",
            lender: "",
            amount_drawn_text: "1,000",
            facility_size_text: "",
            currency: "GBP",
            maturity: "",
            rate_or_margin: "",
            security: "",
            ranking: "",
            pdf_page_index: pages.indexOf(layout.pages.find((p) => p.roles.includes("borrowings_note"))!.page) + 1,
          },
        ],
        maturity_buckets: [],
      },
    };
    for (const f of layout.figures) {
      const at = pages.indexOf(f.page) + 1;
      w.lines = w.lines.map((l) =>
        l.key === f.key
          ? {
              ...l,
              status: "found",
              abstain_reason: "",
              printed_label: f.label,
              figure_text: f.text,
              sign: "positive",
              scale_caption: layout.scale,
              pdf_page_index: at,
              printed_page_number: String(f.page - layout.offset),
              statement: "Group income statement",
              period_end: layout.periodEnd,
            }
          : l
      );
    }
    return w;
  };
}

// The second read agreeing with the layout's figures, on the pages it is sent.
function agreeingSecondRead(layout: Layout, req: LLMRequest): SecondReadWire {
  const cited = [...new Set(layout.figures.map((f) => f.page))].sort((a, b) => a - b);
  void req;
  return {
    lines: layout.figures.map((f) => ({
      key: f.key,
      status: "found",
      abstain_reason: "",
      printed_label: f.label,
      figure_text: f.text,
      sign: "positive",
      scale_caption: layout.scale,
      header_scale_caption: layout.scale,
      header_currency: "£",
      column_heading: layout.periodEnd.slice(0, 4),
      period_end: layout.periodEnd,
      excerpt_page: cited.indexOf(f.page) + 1,
      statement: "Group income statement",
      basis: "consolidated",
      basis_text: "Group income statement",
    })),
    tie_lines: TIE_ROLES.map((role) => ({
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
    })),
  };
}

// One reader for both reads, as in production (the double read uses the same model).
function layoutReaderProvider(layout: Layout): Script {
  let lastSubset: number[] = [];
  const read = layoutReader(layout, () => lastSubset);
  const provider: Script = new Script("claude-opus-5", (stage, req) => {
    if (stage === "second-read") return agreeingSecondRead(layout, req);
    return read(req);
  });
  // The reader learns the subset from the page-finding result, which the test passes in.
  (provider as any).setSubset = (pages: number[]) => (lastSubset = pages);
  return provider;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const bytesCache = new Map<string, Uint8Array>();
function pdfBytes(c: LargeFiling): Uint8Array {
  if (!bytesCache.has(c.number)) bytesCache.set(c.number, new Uint8Array(readFileSync(join(GOLD, c.folder, "filing.pdf"))));
  return bytesCache.get(c.number)!.slice();
}
const byNumber = (n: string) => LARGE_FILINGS.find((c) => c.number === n)!;
const TESCO = byNumber("00445790");

// The pages the layout's finder will choose: what selectPages makes of the layout.
function expectedPages(layout: Layout): number[] {
  // selectPages adds the neighbours of the statements and of the borrowings note only when they
  // were classified; in a real run every page in the range is, so the pages between are "other".
  const lo = Math.min(...layout.pages.map((p) => p.page)) - 2;
  const hi = Math.max(...layout.pages.map((p) => p.page)) + 2;
  const classified: ClassifiedPage[] = Array.from({ length: hi - lo + 1 }, (_, i) => {
    const known = layout.pages.find((p) => p.page === lo + i);
    return { page: lo + i, printedPage: String(lo + i - layout.offset), basis: known?.basis ?? "group", roles: known?.roles ?? ["other"] };
  });
  return selectPages(classified, layout.offset)!.pages;
}

async function pageFound(c: LargeFiling, opts: { finder?: Script | null; cache?: InMemoryCache; costCapGbp?: number; cacheOnly?: boolean; bytes?: Uint8Array } = {}) {
  const layout = LAYOUT[c.number];
  const reader = layoutReaderProvider(layout);
  (reader as any).setSubset(expectedPages(layout));
  const finder = opts.finder === undefined ? layoutFinder(layout) : opts.finder;
  const cache = opts.cache ?? new InMemoryCache();
  const read = (await readScannedAccounts(
    { pdfBytes: opts.bytes ?? pdfBytes(c), transactionId: c.transactionId, companyNumber: c.number, pageCount: c.pageCount },
    { provider: reader, pageFinder: finder, cache, costCapGbp: opts.costCapGbp, cacheOnly: opts.cacheOnly }
  )) as PagedVisionReadResult;
  return { layout, reader, finder, cache, read };
}

const found = (read: PagedVisionReadResult, key: BaseLineKey) => read.lines[key] as FoundLine;
const reason = (read: PagedVisionReadResult) => {
  const l = read.lines.turnover;
  return l.status === "abstain" ? l.reason : "";
};

// ---------------------------------------------------------------------------

suite("pageFinding / pdf-lib cuts the large scans");

for (const c of LARGE_FILINGS) {
  test(`${c.name}: a cut holds exactly the chosen pages, and each page image is byte for byte the original's`, async () => {
    const doc = await openPdf(pdfBytes(c));
    assert(doc !== null, "pdf-lib opens the scan despite its broken cross-reference table");
    assertEqual(doc!.getPageCount(), c.pageCount, "every page is found");
    const wanted = expectedPages(LAYOUT[c.number]);
    const cut = await cutPages(doc!, [...wanted].reverse().concat(wanted[0]));
    assert(cut !== null, "the pages can be cut");
    assertEqual(cut!.pages.join(","), wanted.join(","), "ascending, duplicates removed");
    assertEqual(await pdfPageCount(cut!.bytes), wanted.length, "the new PDF has that many pages");
    assert(cut!.bytes.length < pdfBytes(c).length / 8, `the subset is a small part of the filing (${cut!.bytes.length} of ${pdfBytes(c).length} bytes)`);
    const reopened = await PDFDocument.load(cut!.bytes);
    const image = (d: PDFDocument, i: number): Buffer => {
      const xobjects = d.getPage(i).node.Resources()!.lookup(PDFName.of("XObject"), PDFDict);
      const [, ref] = xobjects.entries()[0];
      return Buffer.from((d.context.lookup(ref) as PDFRawStream).contents);
    };
    for (let i = 0; i < wanted.length; i++) {
      assert(image(reopened, i).equals(image(doc!, wanted[i] - 1)), `page ${wanted[i]} carries the same image bytes`);
    }
  });
}

test("a page outside the filing, or no page at all, cannot be cut", async () => {
  const doc = (await openPdf(pdfBytes(TESCO)))!;
  assertEqual(await cutPages(doc, [0]), null, "page 0");
  assertEqual(await cutPages(doc, [237]), null, "past the end");
  assertEqual(await cutPages(doc, []), null, "nothing");
});

test("bytes that are not a PDF do not open", async () => {
  assertEqual(await openPdf(new Uint8Array(Buffer.from("%PDF-1.4 not really"))), null, "garbage");
});

test("a subset page index maps back to the original, and anything outside the subset to 0", () => {
  assertEqual(toOriginalPage([123, 125, 175], 1), 123, "first");
  assertEqual(toOriginalPage([123, 125, 175], 3), 175, "last");
  assertEqual(toOriginalPage([123, 125, 175], 4), 0, "past the subset");
  assertEqual(toOriginalPage([123, 125, 175], 0), 0, "not known");
});

suite("pageFinding / the passes find the statements and the debt notes");

test("the printed page offset is the most common difference, and none is claimed without a printed number", () => {
  assertEqual(pageOffset([{ page: 4, printed: 2 }, { page: 5, printed: 3 }, { page: 9, printed: 1 }]), 2, "two of three say +2");
  assertEqual(pageOffset([{ page: 4, printed: null }]), null, "no printed numbers");
});

for (const c of LARGE_FILINGS) {
  test(`${c.name}: the range from the real contents page holds every statement and debt-note page`, () => {
    const layout = LAYOUT[c.number];
    const range = rangeFromContents({ contentsPage: layout.contentsPage, offset: layout.offset, entries: layout.entries }, c.pageCount)!;
    for (const p of layout.pages.filter((x) => x.basis === "group")) {
      assert(p.page >= range.from && p.page <= range.to, `page ${p.page} (${p.roles.join(",")}) in ${range.from}-${range.to}`);
    }
    assert(range.to - range.from + 1 <= 110, `the range is part of the filing, not all of it (${range.to - range.from + 1} pages)`);
  });
}

test("with no printed page numbers read, the range widens rather than guessing an offset", () => {
  const layout = LAYOUT["00445790"];
  const known = rangeFromContents({ contentsPage: 6, offset: 2, entries: layout.entries }, 236)!;
  const unknown = rangeFromContents({ contentsPage: 6, offset: null, entries: layout.entries }, 236)!;
  assert(unknown.from <= known.from && unknown.to >= known.to, `${unknown.from}-${unknown.to} covers ${known.from}-${known.to}`);
});

test("group statements are preferred over the parent company's, and company notes are dropped", () => {
  const sel = selectPages([
    { page: 123, printedPage: "121", basis: "group", roles: ["income_statement"] },
    { page: 125, printedPage: "123", basis: "group", roles: ["balance_sheet"] },
    { page: 202, printedPage: "200", basis: "company", roles: ["balance_sheet"] },
    { page: 175, printedPage: "173", basis: "group", roles: ["borrowings_note"] },
    { page: 206, printedPage: "204", basis: "company", roles: ["borrowings_note"] },
  ])!;
  assertEqual(sel.byRole.balance_sheet!.join(","), "125", "the group balance sheet only");
  assertEqual(sel.byRole.borrowings_note!.join(","), "175", "the group borrowings note only");
  assert(sel.missing.includes("cash_flow_statement"), "a role not found is named as missing");
});

test("a filing with no group uses the company's own statements", () => {
  const sel = selectPages([
    { page: 10, printedPage: "8", basis: "company", roles: ["income_statement"] },
    { page: 11, printedPage: "9", basis: "company", roles: ["balance_sheet"] },
  ])!;
  assertEqual(sel.pages.join(","), "10,11", "company statements");
});

test("no balance sheet or no income statement is a failed finding", () => {
  assertEqual(selectPages([{ page: 10, printedPage: null, basis: "group", roles: ["income_statement"] }]), null, "no balance sheet");
  assertEqual(selectPages([{ page: 10, printedPage: null, basis: "group", roles: ["balance_sheet"] }]), null, "no income statement");
});

test(`the subset never exceeds ${SUBSET_MAX_PAGES} pages, however many the classifier marks`, () => {
  const many: ClassifiedPage[] = Array.from({ length: 60 }, (_, i) => ({
    page: 100 + i,
    printedPage: null,
    basis: "group",
    roles: ["income_statement", "balance_sheet", "cash_flow_statement", "borrowings_note", "leases_note", "net_debt_note", "cash_flow_note"],
  }));
  assert(selectPages(many)!.pages.length <= SUBSET_MAX_PAGES, "capped");
});

suite("pageFinding / only the subset is read, and every citation is the original page");

for (const c of LARGE_FILINGS) {
  test(`${c.name}: the reader is sent only the found pages, and the whole filing is never sent`, async () => {
    const { layout, reader, finder, read } = await pageFound(c);
    assertEqual(read.outcome, "read", `read: ${read.failure?.detail ?? ""}`);
    const want = expectedPages(layout);
    assertEqual(read.pageFinding!.pages.join(","), want.join(","), "the statements and debt-note pages");
    assertEqual(read.pageSet, want.join(","), "the page set is recorded on the read");
    assertEqual(reader.calls.length, 1, "one read");
    assertEqual(reader.calls[0].pages, want.length, `the reader got ${want.length} pages`);
    assert(reader.calls[0].req.outputSchema === VISION_SCHEMA, "with the first-read schema");
    const userText = (reader.calls[0].req.content as any[]).find((b) => b.type === "text").text;
    assertEqual(userText, excerptUserText(c.number, want.length, c.pageCount), "and told it is an excerpt");
    for (const call of [...finder!.calls, ...reader.calls]) {
      assert(call.pages > 0 && call.pages <= 30, `${call.stage}: ${call.pages} pages sent, never ${c.pageCount}`);
    }
    assertEqual(finder!.calls[0].stage, "contents", "the contents pass first");
    assert(finder!.calls[0].req.outputSchema === CONTENTS_SCHEMA, "with its schema");
    assert(finder!.calls.slice(1).every((x) => x.req.outputSchema === CLASSIFY_SCHEMA), "then classification only");
  });
}

test("Tesco: every page index in the read is the original filing's, not the subset's", async () => {
  const { read, layout } = await pageFound(TESCO);
  for (const f of layout.figures) {
    assertEqual(found(read, f.key).pdfPageIndex, f.page, `${f.key} cites PDF page ${f.page} of the filing`);
  }
  assert(read.debtNote.status === "found", "debt note read");
  if (read.debtNote.status === "found") {
    assertEqual(read.debtNote.pdfPageIndexes.join(","), "158", "the borrowings note page, original numbering");
    assertEqual(read.debtNote.facilities[0].pdfPageIndex, 158, "and a facility's page");
  }
});

test("Tesco: the double read cuts the cited pages from the original bytes, and each figure surfaces with its original page and pounds", async () => {
  const { read, reader, layout } = await pageFound(TESCO);
  const verification = await new DoubleReadVerifier({ provider: reader, cache: new InMemoryCache() }).verify({ read, pdfBytes: pdfBytes(TESCO), pageCount: TESCO.pageCount });
  const second = reader.calls.find((x) => x.stage === "second-read")!;
  assertEqual(second.pages, 2, "the second read got the two cited pages (income statement and balance sheet)");
  const applied = applyVerification(read, verification);
  const mapped = visionLines(applied.read, applied.tags, TESCO.madeUpDate);
  for (const f of layout.figures) {
    const fig = mapped.figures.find((x) => x.key === f.key);
    assert(fig !== undefined, `${f.key} surfaces`);
    assertEqual(fig!.tag.evidence!.pounds, f.pounds, `${f.key} in pounds`);
    assertEqual(fig!.line.pdfPageIndex, f.page, `${f.key} cites page ${f.page}`);
  }
});

test("the result's usage adds the page-finding calls to the read, and the summary keeps them apart", async () => {
  const { read, finder, reader } = await pageFound(TESCO);
  const pf = read.pageFinding!;
  assertEqual(pf.calls, finder!.calls.length, "page-finding call count");
  const finderGbp = pf.usage!.costGbp!;
  assert(read.usage!.costGbp! > finderGbp, "the read costs on top");
  assert(read.usage!.model.includes("claude-opus-5") && read.usage!.model.includes("claude-haiku-4-5"), `both models named: ${read.usage!.model}`);
  assertEqual(reader.calls.length, 1, "one read");
});

test("a repeat makes no call at all: the finding and the read of its subset are both cached", async () => {
  const cache = new InMemoryCache();
  const first = await pageFound(TESCO, { cache });
  assertEqual(first.read.fromCache, false, "first run pays");
  const again = await pageFound(TESCO, { cache });
  assertEqual(again.finder!.calls.length + again.reader.calls.length, 0, "no call");
  assertEqual(again.read.fromCache, true, "served from the cache");
  assertEqual(found(again.read, "turnover").pdfPageIndex, 123, "with the same citation");
});

test("cache-only serves a held read, and with nothing held abstains without a call", async () => {
  const cache = new InMemoryCache();
  await pageFound(TESCO, { cache });
  const held = await pageFound(TESCO, { cache, cacheOnly: true });
  assertEqual(held.read.fromCache, true, "held read served");
  const empty = await pageFound(TESCO, { cacheOnly: true });
  assertEqual(empty.finder!.calls.length + empty.reader.calls.length, 0, "no call");
  assertEqual(empty.read.outcome, "cache-miss", "cache-miss");
  assertEqual(reason(empty.read), "cache-only-no-model-call", "with its reason");
});

// WP-BE14: with no model configured, reads already paid for are still served. Before, the
// page-found path returned "unconfigured" before it looked in the cache, and every no-model path
// looked under the model "none", which nothing paid is ever stored under (QA04, 27 Sep).
async function withLlmModel<T>(model: string | undefined, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.LLM_MODEL;
  if (model === undefined) delete process.env.LLM_MODEL;
  else process.env.LLM_MODEL = model;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.LLM_MODEL;
    else process.env.LLM_MODEL = saved;
  }
}

test("no model configured: a paid page-found read and its second read are served from the cache (WP-BE14)", async () => {
  const cache = new InMemoryCache();
  const paid = await pageFound(TESCO, { cache });
  const paidVerification = await new DoubleReadVerifier({ provider: paid.reader, cache }).verify({ read: paid.read, pdfBytes: pdfBytes(TESCO), pageCount: TESCO.pageCount });
  const tx = { pdfBytes: pdfBytes(TESCO), transactionId: TESCO.transactionId, companyNumber: TESCO.number, pageCount: TESCO.pageCount };
  await withLlmModel("claude-opus-5", async () => {
    const served = (await readScannedAccounts(tx, { provider: null, pageFinder: null, cache })) as PagedVisionReadResult;
    assertEqual(served.fromCache, true, "the paid read is served");
    assertEqual(served.outcome, "read", "as a read, not unconfigured");
    assertEqual(found(served, "turnover").pdfPageIndex, found(paid.read, "turnover").pdfPageIndex, "with the same citation");
    const v = await new DoubleReadVerifier({ provider: null, cache }).verify({ read: served, pdfBytes: pdfBytes(TESCO), pageCount: TESCO.pageCount });
    assertEqual(JSON.stringify(v.lines), JSON.stringify(paidVerification.lines), "the paid second read is served too");
    assertEqual(v.usage, null, "and no call is made");
  });
  // Nothing names the model: there is no key to look under, so it abstains as before.
  await withLlmModel(undefined, async () => {
    const none = await readScannedAccounts(tx, { provider: null, pageFinder: null, cache });
    assertEqual(none.outcome, "unconfigured", "unconfigured when no model is named");
  });
  // A different model named: its reads were never paid for, so it abstains.
  await withLlmModel("claude-sonnet-5", async () => {
    const other = await readScannedAccounts(tx, { provider: null, pageFinder: null, cache });
    assertEqual(other.outcome, "unconfigured", "another model's key misses");
  });
});

test("when the contents page points away from the statements, the rest of the filing is classified", async () => {
  const layout = LAYOUT["00445790"];
  // A contents page read wrongly: everything 100 printed pages early.
  const finder = layoutFinder(layout, { contents: (a) => a.entries.forEach((e: any) => (e.printed_page = String(Number(e.printed_page) - 100))) });
  const { read } = await pageFound(TESCO, { finder });
  assertEqual(read.outcome, "read", `still read: ${read.failure?.detail ?? ""}`);
  assertEqual(read.pageFinding!.range!.how, "contents-then-rest", "it looked at the rest");
  assertEqual(read.pageFinding!.pages.join(","), expectedPages(layout).join(","), "and found the right pages");
});

test("with no contents page, the whole filing is classified if the cap allows", async () => {
  const layout = LAYOUT["00445790"];
  const finder = layoutFinder(layout, { contents: (a) => ((a.contents_found = "no"), (a.contents_pdf_page_index = 0), (a.entries = [])) });
  const { read } = await pageFound(TESCO, { finder });
  assertEqual(read.outcome, "read", "read");
  assertEqual(read.pageFinding!.range!.how, "whole-document", "classified the lot");
  assertEqual(read.pageFinding!.range!.from, CONTENTS_SCAN_PAGES + 1, "after the pages already seen");
});

test("a filing of 60 pages still goes whole; one of 61 is page-found", async () => {
  const bytes = pdfBytes(TESCO);
  const whole = new Script("claude-opus-5", () => ({ ...layoutReader(LAYOUT["00445790"], () => [123])({} as LLMRequest) }));
  const r60 = await readScannedAccounts({ pdfBytes: bytes, transactionId: "t60", companyNumber: "00445790", pageCount: PAGE_FINDING_ABOVE_PAGES }, { provider: whole, pageFinder: null, cache: new InMemoryCache() });
  assertEqual(r60.pageSet, "all", "60 pages: whole");
  const r61 = await readScannedAccounts({ pdfBytes: bytes, transactionId: "t61", companyNumber: "00445790", pageCount: PAGE_FINDING_ABOVE_PAGES + 1 }, { provider: whole, pageFinder: null, cache: new InMemoryCache() });
  assertEqual(whole.calls.length, 1, "only the 60-page filing was sent");
  assertEqual(reason(r61 as PagedVisionReadResult), "page-finding-unconfigured", "61 pages: page-found (and no finder here)");
});

suite("pageFinding / every failure abstains, and the whole document is never sent");

async function failing(opts: Parameters<typeof pageFound>[1], expected: string) {
  const r = await pageFound(TESCO, opts);
  assertEqual(r.read.outcome, "too-large", "not read");
  for (const k of BASE_LINE_KEYS) {
    const l = r.read.lines[k];
    assert(l.status === "abstain" && l.reason === expected, `${k} abstains with ${expected}`);
  }
  assert(r.read.debtNote.status === "abstain", "the debt note abstains");
  assertEqual(r.reader.calls.length, 0, "the reader is never called");
  assert(r.read.failure!.detail.includes("the whole document was not sent"), `the failure says so: ${r.read.failure!.detail}`);
  return r;
}

test("no page finder configured", async () => {
  await failing({ finder: null }, "page-finding-unconfigured");
});

test("a PDF that cannot be opened for cutting abstains before any call", async () => {
  const r = await failing({ bytes: new Uint8Array(Buffer.from("%PDF-1.4\nnot a real pdf")) }, "page-finding-pdf-unreadable");
  assertEqual(r.finder!.calls.length, 0, "no page-finding call either");
});

test("the statements are nowhere to be found", async () => {
  const layout = LAYOUT["00445790"];
  const finder = layoutFinder(layout, { classify: (a) => a.pages.forEach((p: any) => (p.roles = ["other"])) });
  const r = await failing({ finder }, "page-finding-statements-not-found");
  assertEqual(r.read.pageFinding!.failure!.reason, "page-finding-statements-not-found", "the summary names it");
});

test("a page-finding call that fails (the live attempt of 22 Sep: HTTP 400, credit balance too low)", async () => {
  const rec = JSON.parse(readFileSync(join(RECORDINGS, "00445790.json"), "utf8"));
  const failed = rec.calls.find((c: any) => c.status !== 200);
  const provider = new AnthropicProvider(
    { provider: "anthropic", model: "claude-haiku-4-5", apiKey: "replay", maxTokens: 1024 },
    {
      fetchImpl: async () => new Response(JSON.stringify(failed?.response ?? { type: "error" }), { status: failed?.status ?? 400, headers: { "content-type": "application/json" } }),
      logUsage: () => {},
      sleep: async () => {},
    } as never
  );
  const finder = new Script("claude-haiku-4-5", () => ({}));
  (finder as any).send = (req: LLMRequest) => provider.send(req);
  await failing({ finder }, "page-finding-model-failure");
});

test("page-finding output that does not validate", async () => {
  const finder = new Script("claude-haiku-4-5", () => ({ contents_found: "maybe" }));
  await failing({ finder }, "page-finding-malformed-output");
});

test("a cost cap too small for the read abstains before any call", async () => {
  const r = await failing({ costCapGbp: 0.05 }, "page-finding-over-cost-cap");
  assertEqual(r.finder!.calls.length, 0, "no page-finding call");
});

test("a cap that covers the contents pass but not the classification stops after the contents pass", async () => {
  const readReserve = estimateCostGbp("claude-opus-5", SUBSET_MAX_PAGES, READ_OUTPUT_TOKENS_ESTIMATE)!;
  const contents = estimateCostGbp("claude-haiku-4-5", CONTENTS_SCAN_PAGES, CONTENTS_OUTPUT_TOKENS)!;
  const r = await failing({ costCapGbp: readReserve + contents + 0.03 }, "page-finding-over-cost-cap");
  assertEqual(r.finder!.calls.length, 1, "only the contents pass ran");
});

suite("pageFinding / the cost of a large filing, by estimate");

for (const c of LARGE_FILINGS) {
  test(`${c.name}: page-finding plus both reads is estimated under GBP 1`, async () => {
    const layout = LAYOUT[c.number];
    const range = rangeFromContents({ contentsPage: layout.contentsPage, offset: layout.offset, entries: layout.entries }, c.pageCount)!;
    const span = range.to - range.from + 1;
    const pages = expectedPages(layout).length;
    const finding =
      estimateCostGbp("claude-haiku-4-5", CONTENTS_SCAN_PAGES, CONTENTS_OUTPUT_TOKENS)! +
      estimateCostGbp("claude-haiku-4-5", span, span * CLASSIFY_OUTPUT_TOKENS_PER_PAGE)!;
    const firstRead = estimateCostGbp("claude-opus-5", pages, READ_OUTPUT_TOKENS_ESTIMATE)!;
    const secondRead = 0.15; // the top of the WP-BE05 measured range
    const total = finding + firstRead + secondRead;
    assert(finding + firstRead <= PAGE_FINDING_COST_CAP_GBP, `inside the cap: GBP ${(finding + firstRead).toFixed(3)}`);
    assert(total < 1, `GBP ${total.toFixed(3)} (finding ${finding.toFixed(3)} on ${span} pages, first read ${firstRead.toFixed(3)} on ${pages}, second ${secondRead})`);
    const whole = estimateCostGbp("claude-opus-5", c.pageCount, READ_OUTPUT_TOKENS_ESTIMATE)!;
    assert(whole > 1, `against GBP ${whole.toFixed(2)} for the whole filing`);
  });
}

suite("pageFinding / recorded live runs replay offline");

for (const c of LARGE_FILINGS) {
  const path = join(RECORDINGS, `${c.number}.json`);
  const rec = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  const complete = rec && rec.calls.length > 0 && rec.calls.every((x: any) => x.status === 200);
  if (!complete) continue; // no successful recording yet; the scripted suites above cover the path
  test(`${c.name}: the recorded run replays, sends only its subset, and met 90 seconds and GBP 1`, async () => {
    const byStage = new Map<string, any>(rec.calls.map((x: any) => [x.stage, x.response]));
    const replay = (model: string) =>
      new AnthropicProvider(
        { provider: "anthropic", model, apiKey: "replay", maxTokens: 1024 },
        {
          fetchImpl: async (_u: unknown, init?: RequestInit) => {
            const stage = stageOf(JSON.parse(String(init?.body)));
            const response = byStage.get(stage);
            if (!response) throw new Error(`no recorded response for ${stage}`);
            return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
          },
          logUsage: () => {},
        }
      );
    const reader = replay(rec.readerModel);
    const cache = new InMemoryCache();
    const read = (await readScannedAccounts(
      { pdfBytes: pdfBytes(c), transactionId: c.transactionId, companyNumber: c.number, pageCount: c.pageCount },
      { provider: reader, pageFinder: replay(rec.finderModel), cache }
    )) as PagedVisionReadResult;
    assertEqual(read.outcome, "read", "the recorded read validates");
    assertEqual(read.pageFinding!.pages.join(","), rec.pagesSent.join(","), "the same pages as recorded");
    assert(read.pageFinding!.pages.length <= SUBSET_MAX_PAGES, "a subset");
    assert(rec.seconds.total < 90, `recorded in ${rec.seconds.total}s`);
    assert(rec.gbp < 1, `recorded at GBP ${rec.gbp}`);
  });
}

// ---------------------------------------------------------------------------
// WP-BE21: the page-finder stops one page short
// ---------------------------------------------------------------------------

suite("pageFinding / WP-BE21: Kemble Water, and the notes past the range");

const KEMBLE = JSON.parse(readFileSync(join(RECORDINGS, "05819262-finder.json"), "utf8"));
const kembleText = (stage: string): string => {
  const call = KEMBLE.calls.find((c: any) => c.stage === stage);
  return call.response.content.find((b: any) => b.type === "text").text;
};

// The finder's recorded answers, by the stage each request asks for. An unrecorded stage throws,
// so a test that asks for pages the recording never saw fails loudly.
function replayFinder(calls: { stage: string; response: unknown }[], edit?: (stage: string, text: string) => string): AnthropicProvider {
  const byStage = new Map(calls.map((c) => [c.stage, c.response as any]));
  return new AnthropicProvider(
    { provider: "anthropic", model: "claude-haiku-4-5", apiKey: "replay", maxTokens: 1024 },
    {
      fetchImpl: async (_u: unknown, init?: RequestInit) => {
        const stage = stageOf(JSON.parse(String(init?.body)));
        const response = byStage.get(stage);
        if (!response) throw new Error(`no recorded response for ${stage}`);
        const out = edit
          ? { ...response, content: response.content.map((b: any) => (b.type === "text" ? { ...b, text: edit(stage, b.text) } : b)) }
          : response;
        return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
      },
      logUsage: () => {},
    }
  );
}

// The Kemble scan is 6.6 MB and not in the gold set, so it is not committed. Replay answers by the
// pages a request asks about, never by what is on them, so blank pages of the same count stand in.
async function blankPdf(pages: number): Promise<PDFDocument> {
  const d = await PDFDocument.create();
  for (let i = 0; i < pages; i++) d.addPage([200, 280]);
  return (await openPdf(await d.save()))!;
}

const kembleContents = (): ContentsFinding => {
  const w = JSON.parse(kembleText("contents"));
  return {
    contentsPage: w.contents_pdf_page_index,
    offset: 1,
    entries: w.entries.map((e: any) => ({ section: e.section, title: e.title_as_printed, printedPage: Number(e.printed_page) })),
  };
};

test("Kemble Water: the recorded run that sent pages 39, 41 and 45 now sends the income statement, balance sheet and cash flow on 40, 42 and 46", async () => {
  const doc = await blankPdf(KEMBLE.pageCount);
  const found = await findPages(
    { doc, transactionId: "kemble", companyNumber: "05819262", readerModel: "claude-opus-5" },
    { finder: replayFinder(KEMBLE.calls) }
  );
  assert(found.ok, `found: ${found.ok ? "" : found.detail}`);
  if (!found.ok) return;
  const f = found.finding;
  assertEqual(f.byRole.income_statement!.join(","), String(KEMBLE.truth.income_statement), "the income statement (PDF 40, printed 39)");
  assertEqual(f.byRole.balance_sheet!.join(","), String(KEMBLE.truth.balance_sheet), "the balance sheet (PDF 42, printed 41)");
  assertEqual(f.byRole.cash_flow_statement!.join(","), String(KEMBLE.truth.cash_flow_statement), "the cash flow statement (PDF 46)");
  for (const p of [40, 42, 46]) assert(f.pages.includes(p), `page ${p} goes to the reader (sent: ${f.pages.join(",")})`);
  assertEqual(JSON.stringify(f.moved), JSON.stringify([{ from: 37, to: 66, by: 1 }]), "the slipped chunk was moved by one, and only that chunk");
  assert((f.byRole.borrowings_note ?? []).some((p) => p >= 82 && p <= 85), `the borrowings note is found now the range reaches it (${f.byRole.borrowings_note})`);
  assertEqual(f.range.to, KEMBLE.pageCount, "the range no longer stops at the company balance sheet");
  assert(f.pages.length <= SUBSET_MAX_PAGES, "still a subset");
});

test("Kemble Water: with only the slipped chunk to go on, nothing is moved, and the neighbours still carry every statement", () => {
  const slipped: ClassifiedPage[] = JSON.parse(kembleText("classify:37-66")).pages.map((p: any) => ({
    page: 36 + p.pdf_page_index,
    printedPage: p.printed_page_number,
    basis: p.basis,
    roles: p.roles,
  }));
  assertEqual(reconcileChunks([slipped], 1).moved.length, 0, "one chunk alone is never moved");
  const sel = selectPages(slipped, 1)!;
  assertEqual(sel.byRole.income_statement!.join(","), "39", "the classifier still says 39");
  for (const p of [40, 42, 46]) assert(sel.pages.includes(p), `but page ${p} is sent as a neighbour (${sel.pages.join(",")})`);
});

test("the company balance sheet printed beside the group's does not end the group notes (Kemble, Zenith, Cath Kidston)", () => {
  const cases: { name: string; c: ContentsFinding; pageCount: number; debtPage: number }[] = [
    // Kemble: borrowings note classified on PDF 82 to 85 in the recorded run.
    { name: "Kemble Water", c: kembleContents(), pageCount: 116, debtPage: 85 },
    // Zenith and Cath Kidston: the contents entries as the finder returned them on 24 Sep.
    {
      name: "Zenith",
      c: {
        contentsPage: 2,
        offset: 0,
        entries: [
          { section: "group_income_statement", title: "Consolidated statement of profit and loss", printedPage: 65 },
          { section: "group_balance_sheet", title: "Consolidated balance sheet", printedPage: 66 },
          { section: "group_cash_flow_statement", title: "Consolidated cash flow statement", printedPage: 68 },
          { section: "group_notes", title: "Notes to the financial statements", printedPage: 69 },
          { section: "company_financial_statements", title: "Company balance sheet", printedPage: 66 },
        ],
      },
      pageCount: 111,
      debtPage: 90, // not located: any page 20 into the notes stands for "past the first few"
    },
    {
      name: "Cath Kidston",
      c: {
        contentsPage: 2,
        offset: 2,
        entries: [
          { section: "group_income_statement", title: "Consolidated income statement", printedPage: 12 },
          { section: "group_balance_sheet", title: "Consolidated balance sheet", printedPage: 14 },
          { section: "company_financial_statements", title: "Company balance sheet", printedPage: 16 },
          { section: "group_cash_flow_statement", title: "Consolidated cash flow statement", printedPage: 19 },
          { section: "group_notes", title: "Notes to the consolidated financial statements", printedPage: 20 },
        ],
      },
      pageCount: 65,
      debtPage: 45,
    },
  ];
  for (const x of cases) {
    const r = rangeFromContents(x.c, x.pageCount)!;
    assert(r.to >= x.debtPage, `${x.name}: the range ${r.from}-${r.to} reaches page ${x.debtPage}`);
  }
  // A company section that does follow the notes still ends them (Tesco, printed 200).
  const tesco = rangeFromContents({ contentsPage: 6, offset: 2, entries: LAYOUT["00445790"].entries }, 236)!;
  assert(tesco.to < 210, `Tesco still stops before its company statements (${tesco.to})`);
});

test("a chunk is moved only when its printed numbers disagree with its positions and the other chunks agree", () => {
  const chunk = (from: number, to: number, drift: number, offset = 1): ClassifiedPage[] =>
    Array.from({ length: to - from + 1 }, (_, i) => ({ page: from + i, printedPage: String(from + i - offset - drift), basis: "group", roles: ["other"] }));
  assertEqual(chunkDrift(chunk(37, 66, 0), 1), 0, "a chunk that agrees has no drift");
  assertEqual(chunkDrift(chunk(37, 66, -1), 1), -1, "one low");
  assertEqual(reconcileChunks([chunk(37, 66, 0), chunk(67, 96, 0)], 1).moved.length, 0, "nothing to move");
  const r = reconcileChunks([chunk(37, 66, -1), chunk(67, 96, 0)], 1);
  assertEqual(JSON.stringify(r.moved), JSON.stringify([{ from: 37, to: 66, by: 1 }]), "the odd chunk out is moved");
  assertEqual(r.chunks[0][0].page, 38, "each of its pages one on");
  assertEqual(r.chunks[0].length, 29, "and the page pushed past its end is left to the chunk that classified it");
  // The offset itself moved between the front pages and the accounts: every chunk disagrees alike.
  assertEqual(reconcileChunks([chunk(37, 66, -1), chunk(67, 96, -1)], 1).moved.length, 0, "every chunk off alike: the offset changed, nothing is moved");
  assertEqual(reconcileChunks([chunk(37, 66, -3), chunk(67, 96, 0)], 1).moved.length, 0, "three out is not a slip; left alone");
  assertEqual(reconcileChunks([chunk(37, 66, -1), chunk(67, 96, 0)], null).moved.length, 0, "no offset read: nothing to compare against");
  const unnumbered = chunk(37, 66, -1).map((p) => ({ ...p, printedPage: null }));
  assertEqual(reconcileChunks([unnumbered, chunk(67, 96, 0)], 1).moved.length, 0, "no printed numbers: nothing is moved");
});

test("a filing whose statements genuinely are not there still fails the finding, and the widening adds nothing to read", async () => {
  // Kemble's recorded answers with every statement role taken away: what a filing with no
  // statements in its range, and none elsewhere, looks like to the finder.
  const strip = (_stage: string, text: string) => {
    const w = JSON.parse(text);
    if (!w.pages) return text;
    for (const p of w.pages) p.roles = ["other"];
    return JSON.stringify(w);
  };
  const calls = [
    ...KEMBLE.calls,
    // The second attempt classifies the rest of the filing, pages 13 to 37 (37 is left over when
    // the slipped chunk is moved on by one); answered as nothing found.
    { stage: "classify:13-37", response: { ...KEMBLE.calls[1].response, content: [{ type: "text", text: JSON.stringify({ pages: Array.from({ length: 25 }, (_, i) => ({ pdf_page_index: i + 1, printed_page_number: String(12 + i), basis: "unclear", roles: ["other"] })) }) }] } },
  ];
  const doc = await blankPdf(KEMBLE.pageCount);
  const found = await findPages({ doc, transactionId: "absent", companyNumber: "05819262", readerModel: "claude-opus-5" }, { finder: replayFinder(calls, strip) });
  assert(!found.ok, "no finding");
  if (found.ok) return;
  assertEqual(found.reason, "page-finding-statements-not-found", `the reason says the statements were not found (${found.detail})`);
  assertEqual(selectPages([{ page: 40, printedPage: "39", basis: "group", roles: ["other"] }]), null, "no statement, no neighbour: nothing to send");
});

test("a line not printed on the pages read says which pages those were; other reasons are left alone", () => {
  assertEqual(
    scopeToPagesRead("not-printed", [39, 41, 45], 116),
    "not-printed on the 3 pages read (PDF pages 39, 41, 45 of 116), which page-finding chose",
    "names the pages"
  );
  assert(scopeToPagesRead("not-printed-as-single-figure", [40], 116).startsWith("not-printed-as-single-figure on the 1 pages read"), "the single-figure reason too");
  assertEqual(scopeToPagesRead("period-unclear", [40], 116), "period-unclear", "another reason is untouched");
});

test("with no borrowings note in the range and group notes running on, the next chunk is classified (Southern Water's shape)", async () => {
  // Southern Water: one company, no company statements, but the contents pass returned one at
  // printed 202, seven pages into notes that run to 233. The borrowings note here is invented for
  // the test at PDF 220, past the range the contents page gives (189 to 205).
  const layout: Layout = {
    contentsPage: 2,
    offset: 1,
    entries: [
      { section: "group_income_statement", title: "Income statement", printedPage: 191 },
      { section: "group_balance_sheet", title: "Statement of financial position", printedPage: 192 },
      { section: "group_cash_flow_statement", title: "Statement of cash flows", printedPage: 194 },
      { section: "group_notes", title: "Notes to the financial statements", printedPage: 195 },
      { section: "company_financial_statements", title: "Statement of financial position", printedPage: 202 },
    ],
    pages: [
      { page: 192, basis: "group", roles: ["income_statement"] },
      { page: 193, basis: "group", roles: ["balance_sheet"] },
      { page: 195, basis: "group", roles: ["cash_flow_statement"] },
      { page: 220, basis: "group", roles: ["borrowings_note"] },
    ],
    periodEnd: "2026-03-31",
    scale: "£m",
    figures: [],
  };
  const finder = layoutFinder(layout);
  const found = await findPages({ doc: await blankPdf(246), transactionId: "sw", companyNumber: "02366670", readerModel: "claude-opus-5" }, { finder });
  assert(found.ok, "found");
  if (!found.ok) return;
  assertEqual(found.finding.range.how, "contents-then-notes", "it went on into the notes");
  assertEqual((found.finding.byRole.borrowings_note ?? []).join(","), "220,221", "and found the borrowings note");
  assertEqual(finder.calls.filter((c) => c.stage.startsWith("classify")).map((c) => c.stage).join(" "), "classify:189-205 classify:206-235", "one more chunk, no more");
});

test("the notes are not followed past the company's own statements", async () => {
  const layout: Layout = {
    ...LAYOUT["00445790"],
    pages: LAYOUT["00445790"].pages.filter((p) => !p.roles.includes("borrowings_note")).concat([{ page: 204, basis: "company", roles: ["other"] }]),
  };
  const finder = layoutFinder(layout);
  const found = await findPages({ doc: (await openPdf(pdfBytes(TESCO)))!, transactionId: "t", companyNumber: "00445790", readerModel: "claude-opus-5" }, { finder });
  assert(found.ok, "found");
  if (!found.ok) return;
  assertEqual(found.finding.range.how, "contents", "no continuation");
  assert(!found.finding.byRole.borrowings_note, "no borrowings note, and none invented");
});
