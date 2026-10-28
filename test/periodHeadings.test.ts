// test/periodHeadings.test.ts
// Period headings (WP-BE22): two-digit years, period ranges, and two-row column headers.
//
// No test calls the API or a model. The Stonegate and Bellis Finco cases below are NOT recordings:
// the WP-BE10 run kept no first or second read for either name (its cache was in memory). The
// filings were fetched again from Companies House on 24 Sep 2026 and the pages opened by eye. Each
// read below is a hand transcription of what those pages print, shaped as the reads would return
// it, and the column headings are the ones the WP-BE10 abstention reasons quote. What they prove is
// the judgement on those headings, not what a live second read would copy into header_rows_above.
//
//   Stonegate Pub Company Financing 2019 plc 12092575, accounts made up to 28 Sep 2025, 28 pages:
//     PDF page 15, "Profit and Loss Account", column "52 Weeks Period 30/9/24 to 28/9/25", £m
//     PDF page 16, "Balance Sheet", column "28/9/25", £m
//   Bellis Finco plc 12855336, group accounts made up to 31 Dec 2025, 205 pages:
//     PDF page 98, "Consolidated Income Statement for the Year Ended 31 December 2025". The
//     column is headed "Post non-underlying items"; the table's header rows print "Year ended
//     31 December 2025" at the left, beside "£m". The 2024 comparative is a second table below
//     it with the same column headings, headed "Year ended 31 December 2024".
//
// No figure here is a gold figure: neither company is in the UK gold set.

import { suite, test, assert, assertEqual } from "./harness";
import { parseSecondRead, type SecondReadWire, type SecondWireLine } from "../lib/vision/secondRead";
import {
  BASIS_ABSTAIN,
  applyVerification,
  doubleReadProblem,
  headingDates,
  judgeDoubleRead,
  periodFromHeading,
  periodFromHeadings,
} from "../lib/vision/verify";
import { visionLines } from "../lib/sources/visionAccounts";
import { BASE_LINE_KEYS, type BaseLineKey, type FoundLine, type VisionLine, type VisionReadResult } from "../lib/vision/types";
import type { AccountsTypeLabel } from "../lib/resolve/accountsType";

// --- Builders -----------------------------------------------------------------

interface Printed {
  page: number;
  label: string;
  text: string; // the figure as printed
  statement: string;
  column: string; // the column heading as printed
  rowsAbove?: string[]; // what the second read copies into header_rows_above
}

function found(p: Printed, periodEnd: string): FoundLine {
  const negative = p.text.startsWith("(");
  const magnitude = Number(p.text.replace(/[(),]/g, ""));
  return {
    status: "found",
    printedLabel: p.label,
    figureText: p.text,
    value: negative ? -magnitude : magnitude,
    sign: negative ? "negative" : "positive",
    scaleCaption: "£m",
    pdfPageIndex: p.page,
    printedPageNumber: null,
    statement: p.statement,
    periodEnd,
    noteReference: null,
  };
}

function readOf(number: string, periodEnd: string, basis: VisionReadResult["document"]["basis"], printed: Partial<Record<BaseLineKey, Printed>>): VisionReadResult {
  const lines = Object.fromEntries(
    BASE_LINE_KEYS.map((k) => [k, printed[k] ? found(printed[k]!, periodEnd) : { status: "abstain", reason: "not-printed" }])
  ) as Record<BaseLineKey, VisionLine>;
  return {
    outcome: "read",
    fromCache: false,
    cacheKey: "test",
    schemaVersion: 2,
    promptVersion: "p2",
    model: "claude-opus-5",
    transactionId: `be22-${number}`,
    companyNumber: number,
    pageSet: "subset",
    document: { companyNameAsPrinted: number, periodEnd, currency: "GBP", basis },
    lines,
    debtNote: { status: "abstain", reason: "not-read" },
    usage: null,
    recordedUsage: null,
  };
}

const notPrinted = (role: SecondReadWire["tie_lines"][number]["role"]) => ({
  role,
  status: "abstain" as const,
  abstain_reason: "not-printed",
  printed_label: "",
  figure_text: "",
  sign: "none" as const,
  scale_caption: "",
  column_heading: "",
  period_end: "",
  excerpt_page: 0,
});

// A second read that sees what the first read cited, with the headings each test gives it.
function wireOf(
  read: VisionReadResult,
  printed: Partial<Record<BaseLineKey, Printed>>,
  basis: SecondWireLine["basis"],
  basisText: string,
  totalEquity?: { text: string; page: number; column: string }
): { wire: SecondReadWire; pages: number[] } {
  const keys = BASE_LINE_KEYS.filter((k) => printed[k]);
  const pages = [...new Set(keys.map((k) => printed[k]!.page))].sort((a, b) => a - b);
  const periodEnd = read.document.periodEnd!;
  const lines: SecondWireLine[] = keys.map((k) => {
    const p = printed[k]!;
    return {
      key: k,
      status: "found",
      abstain_reason: "",
      printed_label: p.label,
      figure_text: p.text,
      sign: p.text.startsWith("(") ? "negative" : "positive",
      scale_caption: "£m",
      header_scale_caption: "£m",
      header_currency: "£",
      column_heading: p.column,
      header_rows_above: p.rowsAbove ?? [],
      period_end: periodEnd,
      excerpt_page: pages.indexOf(p.page) + 1,
      statement: p.statement,
      basis,
      basis_text: basisText,
    };
  });
  const tie_lines = (["total_equity", "total_liabilities", "current_assets", "borrowings_total", "net_debt"] as const).map((role) =>
    role === "total_equity" && totalEquity
      ? {
          role,
          status: "found" as const,
          abstain_reason: "",
          printed_label: "SHAREHOLDERS' FUNDS",
          figure_text: totalEquity.text,
          sign: (totalEquity.text.startsWith("(") ? "negative" : "positive") as "negative" | "positive",
          scale_caption: "£m",
          column_heading: totalEquity.column,
          period_end: periodEnd,
          excerpt_page: pages.indexOf(totalEquity.page) + 1,
        }
      : notPrinted(role)
  );
  return { wire: { lines, tie_lines }, pages };
}

function judge(read: VisionReadResult, wire: SecondReadWire, pages: number[], accountsType: AccountsTypeLabel | null) {
  const judged = judgeDoubleRead(read, wire, pages, undefined, { accountsType });
  const v = applyVerification(read, { verifier: "double-read/test", ...judged, usage: null });
  return { judged, sheet: visionLines(v.read, v.tags, null, { accountsType }) };
}

// --- The cases, as printed ----------------------------------------------------

const STONEGATE_PERIOD = "2025-09-28";
const SG_BS = "Balance Sheet";
const SG_PL = "Profit and Loss Account";
const STONEGATE: Partial<Record<BaseLineKey, Printed>> = {
  total_assets: { page: 16, label: "TOTAT ASSETS", text: "2,124", statement: SG_BS, column: "28/9/25" }, // "TOTAT" sic
  current_liabilities: { page: 16, label: "Creditors: Amounts falling due within one year", text: "(183)", statement: SG_BS, column: "28/9/25" },
  borrowings_after_one_year: { page: 16, label: "Creditors: Amounts falling due after more than one year", text: "(2,085)", statement: SG_BS, column: "28/9/25" },
  net_assets: { page: 16, label: "NET LIABILITIES", text: "(144)", statement: SG_BS, column: "28/9/25" },
  interest_payable: { page: 15, label: "Interest payable and similar expenses", text: "(224)", statement: SG_PL, column: "52 Weeks Period 30/9/24 to 28/9/25" },
};

const BELLIS_PERIOD = "2025-12-31";
const BELLIS_IS = "Consolidated Income Statement for the Year Ended 31 December 2025";
const BELLIS_COLUMN = "Post non-underlying items";
const BELLIS_ROW = "Year ended 31 December 2025";
const bellis = (rowsAbove: string[]): Partial<Record<BaseLineKey, Printed>> => ({
  operating_profit: { page: 98, label: "Operating profit/(loss)", text: "(351.4)", statement: BELLIS_IS, column: BELLIS_COLUMN, rowsAbove },
  interest_payable: { page: 98, label: "Finance costs", text: "(728.9)", statement: BELLIS_IS, column: BELLIS_COLUMN, rowsAbove },
  profit_before_tax: { page: 98, label: "Loss before tax", text: "(989.0)", statement: BELLIS_IS, column: BELLIS_COLUMN, rowsAbove },
});

suite("period headings (WP-BE22)");

// --- Two-digit years and the day-first rule -------------------------------------

test("a dd/mm/yy heading is read day first: 28/9/25 is 28 September 2025", () => {
  assertEqual(headingDates("28/9/25").dates.map((d) => d.iso).join(), "2025-09-28", "28/9/25");
  assertEqual(periodFromHeading("28/9/25", "2025-09-28"), null, "Stonegate's balance sheet column");
  assertEqual(periodFromHeading("28.9.25", "2025-09-28"), null, "dots");
  assertEqual(periodFromHeading("28-09-25", "2025-09-28"), null, "hyphens");
  assert(periodFromHeading("29/9/24", "2025-09-28") !== null, "Stonegate's comparative column abstains");
});

test("an ambiguous two-digit date is read day first and never flipped to match (fails if the rule is month first)", () => {
  // 5/4/25 is 5 April under the UK reading and 4 May under the US one.
  assertEqual(headingDates("5/4/25").dates[0].iso, "2025-04-05", "day first");
  assertEqual(periodFromHeading("5/4/25", "2025-04-05"), null, "accounts made up to 5 April 2025: the day-first reading matches");
  const flipped = periodFromHeading("5/4/25", "2025-05-04");
  assert(flipped !== null, "accounts made up to 4 May 2025: only a month-first reading would match, and it is not accepted");
  assert(/did not match/.test(flipped!), `says the period did not match: ${flipped}`);
  // The same date through the whole judgement: the reads and the accounts all say 4 May, the
  // heading says 5/4/25, and the line abstains.
  const p: Printed = { page: 16, label: "NET LIABILITIES", text: "(144)", statement: SG_BS, column: "5/4/25" };
  const read = readOf("12092575", "2025-05-04", "company", { net_assets: p });
  const { wire, pages } = wireOf(read, { net_assets: p }, "none", "");
  const { sheet } = judge(read, wire, pages, "full");
  assertEqual(sheet.figures.length, 0, "nothing surfaces");
});

// --- US-style dates are never misread (RS-06 finding 6) -------------------------

test("a date with the month in words is read in either order, not judged on its year alone", () => {
  assertEqual(headingDates("December 31, 2025").dates.map((d) => d.iso).join(), "2025-12-31", "US order");
  assertEqual(headingDates("Sept. 30, 2025").dates.map((d) => d.iso).join(), "2025-09-30", "abbreviated, with a stop");
  assertEqual(periodFromHeading("December 31, 2025", "2025-12-31"), null, "the right date passes");
  // Before, neither matched a date pattern, the heading was judged on "2025" alone, and both passed.
  assert(periodFromHeading("December 31, 2025", "2025-06-30") !== null, "a different date in the same year abstains");
  assert(periodFromHeading("Sept. 30, 2025", "2025-12-31") !== null, "so does this one");
});

test("an ISO date is read as a date, not as a year", () => {
  assertEqual(periodFromHeading("2025-12-31", "2025-12-31"), null, "matches");
  assert(periodFromHeading("2025-12-31", "2025-06-30") !== null, "used to pass on 2025 alone");
});

test("a US numeric date is named as one, with what it would have been, and never read", () => {
  const r = periodFromHeading("12/31/2025", "2025-12-31");
  assert(r !== null, "abstains even though month first it is the period end");
  assert(/not a date when read day first/.test(r!) && /month first/.test(r!) && /31 December 2025/.test(r!), `says what it is: ${r}`);
  assertEqual(headingDates("12/31/2025").monthFirstOnly.join(), "12/31/2025", "reported as month-first only");
  assertEqual(headingDates("12/31/2025").dates.length, 0, "and not as a date");
  assert(periodFromHeading("1/2/26 to 12/31/26", "2026-12-31") !== null, "a US range abstains");
});

test("an ambiguous date carries both readings, and a match only month first says so", () => {
  assertEqual(headingDates("5/4/25").dates[0].monthFirst, "2025-05-04", "the other reading is kept beside it");
  assertEqual(headingDates("28/9/25").dates[0].monthFirst, undefined, "28/9/25 reads only one way");
  assertEqual(headingDates("5/5/25").dates[0].monthFirst, undefined, "5/5/25 reads the same both ways");
  const r = periodFromHeading("5/4/25", "2025-05-04");
  assert(r !== null && /did not match/.test(r) && /Only a month-first \(US\) reading, 4 May 2025, would match/.test(r), `names the reading it refused: ${r}`);
  // A plain mismatch is not dressed up as an ambiguity.
  const plain = periodFromHeading("5/4/25", "2025-12-31");
  assert(plain !== null && !/month-first/.test(plain), `no mention of month first: ${plain}`);
});

test("through the whole judgement, a column headed with a US date in the same year surfaces nothing", () => {
  const p: Printed = { page: 16, label: "NET LIABILITIES", text: "(144)", statement: SG_BS, column: "December 31, 2025" };
  const read = readOf("12092575", "2025-06-30", "company", { net_assets: p });
  const { wire, pages } = wireOf(read, { net_assets: p }, "none", "");
  const { sheet } = judge(read, wire, pages, "full");
  assertEqual(sheet.figures.length, 0, "nothing surfaces");
});

test("a numeric date that is impossible day first is not a date, and the line abstains", () => {
  const r = periodFromHeading("9/28/25", "2025-09-28");
  assert(r !== null && /not a date when read day first/.test(r), `a month-first date abstains: ${r}`);
  assert(periodFromHeading("31/2/25", "2025-02-28") !== null, "31 February is not a date");
});

test("a period range heading resolves to its end date, not its start", () => {
  assertEqual(periodFromHeading("52 Weeks Period 30/9/24 to 28/9/25", "2025-09-28"), null, "Stonegate's P&L column");
  assert(periodFromHeading("53 Weeks Period 25/9/23 to 29/9/24", "2025-09-28") !== null, "Stonegate's comparative column abstains");
  assertEqual(periodFromHeading("for the period from 1 October 2024 to 28 September 2025", "2025-09-28"), null, "month names");
  const two = periodFromHeading("28/9/25 29/9/24", "2025-09-28");
  assert(two !== null && /more than one date/.test(two), `two dates not joined as a period abstain: ${two}`);
  assert(periodFromHeading("28/9/25 to 30/9/24", "2024-09-30") !== null, "a range that runs backwards abstains");
});

test("the headings that passed before still pass, and the ones that failed still fail", () => {
  assertEqual(periodFromHeading("31 March 2026", "2026-03-31"), null, "full date");
  assertEqual(periodFromHeading("31/03/2026", "2026-03-31"), null, "four-digit numeric");
  assertEqual(periodFromHeading("2025", "2026-01-01"), null, "early January headed the year before");
  assert(periodFromHeading("2025", "2026-03-31") !== null, "last year's column");
  assertEqual(
    periodFromHeading("Current year", "2026-03-31"),
    `The period could not be established: the column heading "Current year" prints no year.`,
    "the heading-only reason is unchanged"
  );
});

// --- Two-row headers -------------------------------------------------------------

test("a column heading with no year takes the period from a header row of the same table, and says so", () => {
  const j = periodFromHeadings(BELLIS_COLUMN, [BELLIS_ROW], BELLIS_PERIOD);
  assert(j.ok, "Bellis's current-year table");
  if (j.ok) {
    assertEqual(j.source.from, "header-row", "tagged as from a header row");
    assertEqual(j.source.text, BELLIS_ROW, "names the row");
  }
  const spanning = periodFromHeadings("Total", ["2025", "Group"], "2025-12-31");
  assert(spanning.ok && spanning.source.from === "header-row" && spanning.source.text === "2025", "a spanning year row");
});

test("a header row with the wrong year abstains: Bellis's comparative table", () => {
  const j = periodFromHeadings(BELLIS_COLUMN, ["Year ended 31 December 2024"], BELLIS_PERIOD);
  assert(!j.ok && /header row above it in the same table reads "Year ended 31 December 2024"/.test(j.reason), `names the row: ${!j.ok && j.reason}`);
});

test("a column heading that prints a year decides alone: a row above cannot rescue the wrong year", () => {
  const j = periodFromHeadings("2024", [BELLIS_ROW], BELLIS_PERIOD);
  assert(!j.ok, "the comparative column stays abstained");
  const k = periodFromHeadings("2025", ["Year ended 31 December 2024"], BELLIS_PERIOD);
  assert(k.ok && k.source.from === "column-heading", "a dated column heading is not overruled by a row");
});

test("no year anywhere the rule allows: the line abstains and the reason names the rows read", () => {
  const j = periodFromHeadings(BELLIS_COLUMN, ["Pre non-underlying items", "Continuing operations"], BELLIS_PERIOD);
  assert(!j.ok, "abstains");
  if (!j.ok) {
    assert(j.reason.includes(`"${BELLIS_COLUMN}" prints no year`), "names the column heading");
    assert(j.reason.includes(`"Pre non-underlying items", "Continuing operations"`), `names both rows read: ${j.reason}`);
  }
  const none = periodFromHeadings(BELLIS_COLUMN, [], BELLIS_PERIOD);
  assert(!none.ok && /no header row above it in the same table was read/.test(none.reason), "says when no row was read");
});

test("the look-up reads at most two rows: a year on a third row is never used", () => {
  const j = periodFromHeadings(BELLIS_COLUMN, ["£m", "Group", BELLIS_ROW], BELLIS_PERIOD);
  assert(!j.ok, "abstains");
  if (!j.ok) {
    assert(j.reason.includes(`"£m", "Group"`), "names the two rows read");
    assert(!j.reason.includes(BELLIS_ROW), "the third row was not read");
  }
});

// --- The two named cases, end to end through the judgement ----------------------

test("Stonegate: the five lines surface, each cited to its page with the printed text and the period", () => {
  const read = readOf("12092575", STONEGATE_PERIOD, "company", STONEGATE);
  const { wire, pages } = wireOf(read, STONEGATE, "none", "", { text: "(144)", page: 16, column: "28/9/25" });
  const { sheet } = judge(read, wire, pages, "full");
  assertEqual(sheet.abstentions.filter((a) => STONEGATE[a.key]).length, 0, `no abstention: ${JSON.stringify(sheet.abstentions.filter((a) => STONEGATE[a.key]))}`);
  const byKey = new Map(sheet.figures.map((f) => [f.key, f]));
  for (const [key, p] of Object.entries(STONEGATE) as [BaseLineKey, Printed][]) {
    const f = byKey.get(key);
    assert(f, `${key} surfaces`);
    assert(f!.citation.includes(`PDF page ${p.page}`), `${key} cites page ${p.page}: ${f!.citation}`);
    assert(f!.citation.includes(`printed as "${p.text}"`), `${key} carries the printed text`);
    assert(f!.citation.includes(`period ended ${STONEGATE_PERIOD}`), `${key} carries the period`);
    assert(f!.citation.includes(`column "${p.column}"`), `${key} carries the column heading`);
    assertEqual(f!.periodEnd, STONEGATE_PERIOD, `${key} period`);
    assert(!f!.tags.includes("period-from-header-row"), `${key}'s period is from its own column heading`);
  }
  assert(byKey.get("net_assets")!.tags.includes("tie-pass"), "net liabilities ties to shareholders' funds");
});

test("Bellis Finco: operating profit, finance costs and profit before tax surface from the header row, tagged as such", () => {
  const printed = bellis([BELLIS_ROW]);
  const read = readOf("12855336", BELLIS_PERIOD, "consolidated", printed);
  const { wire, pages } = wireOf(read, printed, "consolidated", BELLIS_IS);
  const { sheet } = judge(read, wire, pages, "group");
  const byKey = new Map(sheet.figures.map((f) => [f.key, f]));
  for (const [key, p] of Object.entries(printed) as [BaseLineKey, Printed][]) {
    const f = byKey.get(key);
    assert(f, `${key} surfaces: ${JSON.stringify(sheet.abstentions.find((a) => a.key === key))}`);
    assert(f!.citation.includes(`PDF page 98`) && f!.citation.includes(`printed as "${p.text}"`), `${key} cites page and text`);
    assert(f!.citation.includes(`period ended ${BELLIS_PERIOD}`), `${key} carries the period`);
    assert(f!.citation.includes(`from the header row above it in the same table, "${BELLIS_ROW}"`), `${key} says where the year came from: ${f!.citation}`);
    assert(f!.tags.includes("period-from-header-row"), `${key} is tagged`);
    assertEqual(f!.tag.evidence?.second.periodSource?.from, "header-row", `${key} evidence records the source`);
  }
});

test("Bellis Finco read as before WP-BE22, with no header rows: the three lines still abstain, naming what was read", () => {
  const printed = bellis([]);
  const read = readOf("12855336", BELLIS_PERIOD, "consolidated", printed);
  const { wire, pages } = wireOf(read, printed, "consolidated", BELLIS_IS);
  const { sheet } = judge(read, wire, pages, "group");
  assertEqual(sheet.figures.filter((f) => printed[f.key]).length, 0, "nothing surfaces");
  for (const key of Object.keys(printed)) {
    const a = sheet.abstentions.find((x) => x.key === key);
    assert(a && a.reason.includes(`"${BELLIS_COLUMN}" prints no year, and no header row above it in the same table was read`), `${key}: ${a?.reason}`);
  }
});

test("Bellis Finco's comparative table: header row 2024 against accounts made up to 2025 abstains", () => {
  const printed = bellis(["Year ended 31 December 2024"]);
  const read = readOf("12855336", BELLIS_PERIOD, "consolidated", printed);
  const { wire, pages } = wireOf(read, printed, "consolidated", BELLIS_IS);
  const { sheet } = judge(read, wire, pages, "group");
  assertEqual(sheet.figures.filter((f) => printed[f.key]).length, 0, "nothing surfaces");
});

test("a header row the header-row look-up finds must still pass the scale check", () => {
  const printed = bellis([BELLIS_ROW]);
  const read = readOf("12855336", BELLIS_PERIOD, "consolidated", printed);
  const { wire, pages } = wireOf(read, printed, "consolidated", BELLIS_IS);
  for (const l of wire.lines) l.header_scale_caption = "";
  const { sheet } = judge(read, wire, pages, "group");
  assertEqual(sheet.figures.filter((f) => printed[f.key]).length, 0, "no caption, nothing surfaces");
});

test("a header row reading \"Company\" over the column abstains a group filing's line on the basis check", () => {
  const printed = bellis(["Company", BELLIS_ROW]);
  const read = readOf("12855336", BELLIS_PERIOD, "consolidated", printed);
  const { wire, pages } = wireOf(read, printed, "consolidated", BELLIS_IS);
  const { sheet } = judge(read, wire, pages, "group");
  const a = sheet.abstentions.find((x) => x.key === "operating_profit");
  assert(a && a.reason.startsWith(BASIS_ABSTAIN), `abstains on basis: ${a?.reason}`);
});

// --- Landing and recorded reads -------------------------------------------------

test("landing re-checks the period: evidence claiming a header row it did not record lands nothing", () => {
  const printed = bellis([BELLIS_ROW]);
  const read = readOf("12855336", BELLIS_PERIOD, "consolidated", printed);
  const { wire, pages } = wireOf(read, printed, "consolidated", BELLIS_IS);
  const { judged } = judge(read, wire, pages, "group");
  const tag = judged.lines.operating_profit;
  assertEqual(tag.tag, "verified", "verified as judged");
  const line = read.lines.operating_profit as FoundLine;
  assertEqual(doubleReadProblem(line, tag, { accountsType: "group" }), null, "lands as recorded");
  const forged = JSON.parse(JSON.stringify(tag));
  forged.evidence.second.headerRowsAbove = [];
  const why = doubleReadProblem(line, forged, { accountsType: "group" });
  assert(why !== null && /prints no year/.test(why), `the forged record lands nothing: ${why}`);
});

test("a second read recorded before v3 parses with no header rows", () => {
  const { wire } = wireOf(readOf("12855336", BELLIS_PERIOD, "consolidated", bellis([BELLIS_ROW])), bellis([BELLIS_ROW]), "consolidated", BELLIS_IS);
  const old = JSON.parse(JSON.stringify(wire));
  for (const l of old.lines) delete l.header_rows_above;
  const parsed = parseSecondRead(JSON.stringify(old));
  assert(parsed.ok, "parses");
  if (parsed.ok) assert(parsed.value.lines.every((l) => Array.isArray(l.header_rows_above) && l.header_rows_above.length === 0), "rows are []");
});
