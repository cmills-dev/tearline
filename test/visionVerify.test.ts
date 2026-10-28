// test/visionVerify.test.ts
// The double read (WP-BE05). Every test replays a recorded read: the first reads and second reads
// of five frozen UK gold scans were recorded from the live API on 16 Sep 2026
// (test/fixtures/vision/ and test/fixtures/vision/verify/), and are served here through the real
// Anthropic provider with a fetch that returns the recording. No test calls the API or a model.
//
// The abstain paths are proved by replaying a recorded second read with one field changed, so each
// path is exercised on a real response shape rather than on a sketch. Nothing here asserts a
// WP-BE03 gold figure: those are agent-keyed candidates until Cam's spot check. The gold scoring
// lives in eval/gold/uk-verify.ts and reports disagreements rather than failing on them.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { suite, test, assert, assertEqual } from "./harness";
import { InMemoryCache } from "../lib/cache/cache";
import { AnthropicProvider } from "../lib/llm/providers/anthropic";
import { readScannedAccounts } from "../lib/vision/client";
import { pdfPageCount } from "../lib/vision/pages";
import { carriesPages } from "./pdfPages";
import { replayGoldFirstRead } from "./goldFirstRead";
import { SECOND_READ_SCHEMA } from "../lib/vision/secondRead";
import {
  DoubleReadVerifier,
  applyVerification,
  judgeDoubleRead,
  passThroughVerifier,
  periodFromHeading,
  unverified,
} from "../lib/vision/verify";
import { visionLines } from "../lib/sources/visionAccounts";
import { BASE_LINE_KEYS, type BaseLineKey, type FoundLine, type VerifiedLine, type VisionReadResult, type VisionVerifyResult } from "../lib/vision/types";
import { resolveMetric, ebitdaResolver } from "../lib/engine/ladder";
import { runStructuralChecks } from "../lib/engine/verify";
import type { Fact } from "../lib/engine/types";

const HERE = dirname(fileURLToPath(import.meta.url));
const FX = join(HERE, "fixtures", "vision");
const GOLD = join(HERE, "..", "eval", "gold", "fixtures", "uk");

interface Case {
  number: string;
  name: string;
  folder: string;
  transactionId: string;
  pageCount: number;
  first: string; // recording path under test/fixtures/vision
}

const CASES: Case[] = [
  { number: "02662226", name: "Bristol Water", folder: "02662226-2026-03-31", transactionId: "MzU0MjkxMjg1OGFkaXF6a2N4", pageCount: 28, first: "bristol-water-02662226.json" },
  { number: "02103564", name: "Matalan Retail", folder: "02103564-2026-02-28", transactionId: "MzUzNzUwNjA4OGFkaXF6a2N4", pageCount: 86, first: "matalan-retail-02103564.json" },
  { number: "01404552", name: "PizzaExpress", folder: "01404552-2024-12-29", transactionId: "MzQ4MjMyMTE4OWFkaXF6a2N4", pageCount: 26, first: "verify/01404552-first.json" },
  { number: "00769170", name: "Travelodge Hotels", folder: "00769170-2024-12-31", transactionId: "MzQ2NTM4NzUzM2FkaXF6a2N4", pageCount: 69, first: "verify/00769170-first.json" },
  { number: "03558065", name: "Boparan Holdings", folder: "03558065-2025-07-26", transactionId: "MzUxODk5OTExM2FkaXF6a2N4", pageCount: 113, first: "verify/03558065-first.json" },
];
const byNumber = (n: string) => CASES.find((c) => c.number === n)!;

// --- Replay -----------------------------------------------------------------

const pdfCache = new Map<string, Uint8Array>();
function pdf(c: Case): Uint8Array {
  if (!pdfCache.has(c.number)) pdfCache.set(c.number, new Uint8Array(readFileSync(join(GOLD, c.folder, "filing.pdf"))));
  return pdfCache.get(c.number)!.slice();
}

const loadJson = (rel: string) => JSON.parse(readFileSync(join(FX, rel), "utf8"));

// The recorded API response with its answer text optionally rewritten.
function responseWith(recording: { response: any }, mutate?: (answer: any) => void): any {
  const response = JSON.parse(JSON.stringify(recording.response));
  const textBlock = [...response.content].reverse().find((b: any) => b.type === "text");
  if (mutate) {
    const answer = JSON.parse(textBlock.text);
    mutate(answer);
    textBlock.text = JSON.stringify(answer);
  }
  return response;
}

interface Replay {
  provider: AnthropicProvider;
  requests: any[]; // the request bodies the provider sent, parsed
}

function replayProvider(response: any, status = 200): Replay {
  const requests: any[] = [];
  const provider = new AnthropicProvider(
    { provider: "anthropic", model: "claude-opus-5", apiKey: "replay", maxTokens: 1024 },
    {
      fetchImpl: async (_url: unknown, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)));
        const body = status === 200 ? JSON.stringify(response) : JSON.stringify({ error: { type: "api_error", message: "recorded failure" } });
        return new Response(body, { status, headers: { "content-type": "application/json" } });
      },
      logUsage: () => {},
      sleep: async () => {},
    } as never
  );
  return { provider, requests };
}

async function firstRead(c: Case): Promise<VisionReadResult> {
  // Since WP-BE14-LIVE-2 the first reads are the gold re-recordings: the three filings over 60 pages
  // were page-found, so they replay through their recorded page-finding (test/goldFirstRead.ts).
  return replayGoldFirstRead(
    { pdfBytes: pdf(c), transactionId: c.transactionId, companyNumber: c.number, pageCount: c.pageCount },
    c.folder,
    loadJson(c.first).response
  );
}

async function verifyRecorded(
  number: string,
  opts: { mutate?: (answer: any) => void; status?: number; cache?: InMemoryCache; read?: VisionReadResult } = {}
) {
  const c = byNumber(number);
  const read = opts.read ?? (await firstRead(c));
  const second = loadJson(`verify/${number}-second.json`);
  const replay = replayProvider(responseWith(second, opts.mutate), opts.status ?? 200);
  const cache = opts.cache ?? new InMemoryCache();
  const result = await new DoubleReadVerifier({ provider: replay.provider, cache }).verify({ read, pdfBytes: pdf(c), pageCount: c.pageCount });
  const applied = applyVerification(read, result);
  const mapped = visionLines(applied.read, applied.tags, null);
  return { c, read, second, result, requests: replay.requests, mapped, cache };
}

const line = (answer: any, key: BaseLineKey) => answer.lines.find((l: any) => l.key === key);
const tieLine = (answer: any, role: string) => answer.tie_lines.find((l: any) => l.role === role);
const reasonFor = (r: VisionVerifyResult, key: BaseLineKey) => r.overrides[key]?.reason ?? "";
const surfaced = (m: ReturnType<typeof visionLines>, key: BaseLineKey) => m.figures.find((f) => f.key === key);
const citedPages = (read: VisionReadResult) =>
  [...new Set(BASE_LINE_KEYS.filter((k) => read.lines[k].status === "found").map((k) => (read.lines[k] as FoundLine).pdfPageIndex))].sort((a, b) => a - b);

// ---------------------------------------------------------------------------

suite("visionVerify / the second read is sent only what the first read cited");

for (const c of CASES) {
  test(`${c.name}: the request holds only the cited pages, and no figure from the first read`, async () => {
    const { read, second, requests } = await verifyRecorded(c.number);
    assertEqual(requests.length, 1, "one second-read request");
    const body = requests[0];
    const blocks = body.messages[0].content as any[];
    const doc = blocks.find((b) => b.type === "document");
    const sent = new Uint8Array(Buffer.from(doc.source.data, "base64"));
    const pages = citedPages(read);
    assertEqual(JSON.stringify(second.pagesSent), JSON.stringify(pages), "the recording was made on the same pages");
    assertEqual(await pdfPageCount(sent), pages.length, `${pages.length} pages sent, of ${c.pageCount}`);
    assert(await carriesPages(sent, pdf(c), pages), "exactly the cited pages, each image byte for byte this filing's");
    assert(sent.length < pdf(c).length / 4, `the excerpt is a fraction of the filing (${sent.length} of ${pdf(c).length} bytes)`);
    assert(JSON.stringify(body.output_config.format.schema) === JSON.stringify(SECOND_READ_SCHEMA), "the second-read schema, not the first");

    // What the model is told, apart from the page images, depends on nothing the first read
    // answered: a first read with every figure, label, caption, statement and period replaced
    // produces a byte-identical request.
    const words = (b: any) => JSON.stringify({ system: b.system, text: (b.messages[0].content as any[]).filter((x) => x.type === "text") });
    const scrambled = JSON.parse(JSON.stringify(read)) as VisionReadResult;
    for (const k of BASE_LINE_KEYS) {
      const l = scrambled.lines[k];
      if (l.status !== "found") continue;
      Object.assign(l, { figureText: "(987,654)", value: -987654, sign: "negative", printedLabel: "SCRAMBLED LABEL", scaleCaption: "£bn", statement: "SCRAMBLED STATEMENT", periodEnd: "1999-01-01", noteReference: "99" });
    }
    const other = await verifyRecorded(c.number, { read: scrambled });
    assertEqual(words(other.requests[0]), words(body), "the words sent do not change with the first read's answers");
    assertEqual(other.requests[0].messages[0].content.find((b: any) => b.type === "document").source.data, doc.source.data, "nor do the pages");
    for (const k of BASE_LINE_KEYS) {
      const l = read.lines[k];
      if (l.status === "found" && l.figureText.replace(/[^\d]/g, "").length >= 3) {
        assert(!words(body).includes(l.figureText), `${k}: "${l.figureText}" is not in the request`);
      }
    }
  });
}

suite("visionVerify / recorded double reads");

test("Bristol Water: all eight lines agree, and the balance sheet ties hold on net assets", async () => {
  const { result, mapped } = await verifyRecorded("02662226");
  assertEqual(Object.keys(result.overrides).length, 0, "nothing abstained");
  assertEqual(mapped.figures.length, 8, "eight figures surface");
  const na = surfaced(mapped, "net_assets")!;
  assert(na.tags.includes("double-read") && na.tags.includes("tie-pass"), "net assets carries double-read and tie-pass");
  assertEqual(na.value, 25_100_000, "25.1 under £m");
  const cash = surfaced(mapped, "cash_at_bank")!;
  assertEqual(JSON.stringify(cash.tags), JSON.stringify(["double-read"]), "cash took part in no tie that ran, so no tie-pass");
  assert(cash.citation.includes("Checked: double-read"), cash.citation);
  const netDebt = cash.tag.evidence!.ties.find((t) => t.id === "net-debt.borrowings-cash")!;
  assertEqual(netDebt.status, "not-run", "a tie with a side missing is recorded as not run, not failed");
});

test("every surfaced figure on every recorded filing carries a double read that matches it", async () => {
  for (const c of CASES) {
    const { mapped } = await verifyRecorded(c.number);
    for (const f of mapped.figures) {
      const e = f.tag.evidence!;
      assertEqual(e.kind, "double-read", `${c.name} ${f.key}`);
      assertEqual(e.first.figureText, f.line.figureText, `${c.name} ${f.key} evidence is for this figure`);
      assert(e.pounds === Math.round(f.line.value * f.scale * 100) / 100, `${c.name} ${f.key} agreed pounds`);
      assert(f.tags.includes("double-read"), `${c.name} ${f.key} tagged`);
    }
  }
});

// Since WP-BE14-LIVE-2 the Boparan reads are the gold re-recordings. The first read now abstains
// on interest payable ("only-net-finance-charge-printed"), so the two reads no longer disagree on
// it as the WP-BE05 reads did ((57.8) against (64.3)). The disagreement is made by changing one
// field of the recorded second read: its operating profit, printed 122.7 on PDF page 57.
test("Boparan: two reads that disagree abstain, naming both values (the second read's operating profit changed)", async () => {
  const { result, mapped } = await verifyRecorded("03558065", { mutate: (a) => (line(a, "operating_profit").figure_text = "129.2") });
  const reason = reasonFor(result, "operating_profit");
  assert(reason.startsWith("The two reads disagreed"), reason);
  assert(reason.includes('"122.7"') && reason.includes('"129.2"'), reason);
  assert(reason.includes("a difference of £6,500,000"), reason);
  assertEqual(surfaced(mapped, "operating_profit"), undefined, "not on the sheet");
});

// The re-recorded Boparan second read (v4) states the basis of every line itself: the statement
// heading, or the "GROUP" spanning the columns of notes 19 to 21 (PDF pages 90 and 91). The
// WP-BE05 answer stated none, and these tests used to write the printed words in; they now run
// on the recording as it is.
test("Boparan: both reads said 7.5, the borrowings tie did not hold, and both lines abstain with the amount", async () => {
  const { result } = await verifyRecorded("03558065");
  for (const k of ["borrowings_within_one_year", "borrowings_after_one_year"] as BaseLineKey[]) {
    const reason = reasonFor(result, k);
    assert(reason.includes("Borrowings: the maturity split adds to total borrowings failed"), reason);
    assert(reason.includes("out by £200,000"), reason);
  }
});

// The second read is sent only the pages the first read cited (57, 59, 90, 91). Note 28's net
// debt analysis (PDF page 97, "(276.4)") is not among them, so the recorded second read abstains
// on net debt and the net debt tie does not run. The printed net debt is put into the recorded
// answer, one tie line changed, to prove the failure path on the figures Boparan prints.
const withPrintedNetDebt = (answer: any) =>
  Object.assign(tieLine(answer, "net_debt"), {
    status: "found",
    abstain_reason: "",
    printed_label: "Net debt",
    figure_text: "(276.4)",
    sign: "negative",
    scale_caption: "£m",
    column_heading: "26 July 2025",
    period_end: "2025-07-26",
    excerpt_page: 4,
  });

test("Boparan: the net debt tie failure abstains cash and says it may be a definition", async () => {
  const recorded = await verifyRecorded("03558065");
  assertEqual(reasonFor(recorded.result, "cash_at_bank"), "", "as recorded, net debt is not on the pages sent and cash stands");
  const { result } = await verifyRecorded("03558065", { mutate: withPrintedNetDebt });
  const reason = reasonFor(result, "cash_at_bank");
  assert(reason.includes("Net debt") && reason.includes("out by £7,500,000"), reason);
  // The split both reads got wrong was condemned by the borrowings tie first, so net debt is
  // tested against the printed total borrowings, not against the condemned split.
  assert(reason.includes("Borrowings £389,300,000"), reason);
  assert(reason.includes("defined differently"), reason);
});

test("a cached second read is served with no request", async () => {
  const cache = new InMemoryCache();
  const once = await verifyRecorded("01404552", { cache });
  const twice = await verifyRecorded("01404552", { cache, read: once.read });
  assertEqual(twice.requests.length, 0, "no second request");
  assertEqual(twice.result.usage, null, "no usage when nothing was called");
  assertEqual(twice.mapped.figures.length, once.mapped.figures.length, "the same verdict");
});

suite("visionVerify / every abstain path has its reason");

test("disagreement on the value names both values and the difference", async () => {
  const { result, mapped } = await verifyRecorded("02662226", { mutate: (a) => (line(a, "cash_at_bank").figure_text = "1.4") });
  const reason = reasonFor(result, "cash_at_bank");
  assert(reason.startsWith("The two reads disagreed"), reason);
  assert(reason.includes('"1.7"') && reason.includes('"1.4"') && reason.includes("£300,000"), reason);
  assertEqual(surfaced(mapped, "cash_at_bank"), undefined, "abstained");
  assertEqual(mapped.figures.length, 7, "the other seven still surface");
});

test("disagreement on the sign alone abstains", async () => {
  const { result } = await verifyRecorded("02662226", {
    mutate: (a) => Object.assign(line(a, "net_assets"), { figure_text: "(25.1)", sign: "negative" }),
  });
  assert(reasonFor(result, "net_assets").startsWith("The two reads disagreed"), reasonFor(result, "net_assets"));
});

test("a page that prints no scale abstains, even when both reads agree on the value", async () => {
  const { result, mapped } = await verifyRecorded("02662226", { mutate: (a) => (line(a, "cash_at_bank").header_scale_caption = "") });
  const reason = reasonFor(result, "cash_at_bank");
  assert(reason.startsWith("The scale could not be established from the page"), reason);
  assert(reason.includes("pounds, thousands or millions"), reason);
  assertEqual(surfaced(mapped, "cash_at_bank"), undefined, "the right digits are still not shown");
});

test("a thousands header can never let a figure surface as millions (the GBP 41,000 to GBP 41m error)", async () => {
  const { result } = await verifyRecorded("02662226", { mutate: (a) => (line(a, "cash_at_bank").header_scale_caption = "£'000") });
  const reason = reasonFor(result, "cash_at_bank");
  assert(reason.startsWith("The scale did not match the statement header"), reason);
  assert(reason.includes("£'000"), reason);
});

test("a header caption the reader does not understand abstains", async () => {
  const { result } = await verifyRecorded("02662226", { mutate: (a) => (line(a, "cash_at_bank").header_scale_caption = "per share") });
  assert(reasonFor(result, "cash_at_bank").includes("not a unit this reader understands"), reasonFor(result, "cash_at_bank"));
});

test("a header in another currency abstains, and one with no currency at all abstains", async () => {
  const usd = await verifyRecorded("02662226", { mutate: (a) => (line(a, "cash_at_bank").header_scale_caption = "US$m") });
  assert(reasonFor(usd.result, "cash_at_bank").includes("printed in USD"), reasonFor(usd.result, "cash_at_bank"));
  const none = await verifyRecorded("02662226", {
    mutate: (a) => Object.assign(line(a, "cash_at_bank"), { header_scale_caption: "m", header_currency: "" }),
  });
  assert(reasonFor(none.result, "cash_at_bank").startsWith("The currency could not be established"), reasonFor(none.result, "cash_at_bank"));
});

test("the two reads taking different periods abstains", async () => {
  const { result } = await verifyRecorded("02662226", { mutate: (a) => (line(a, "cash_at_bank").period_end = "2025-03-31") });
  const reason = reasonFor(result, "cash_at_bank");
  assert(reason.startsWith("The period did not match") && reason.includes("2025-03-31"), reason);
});

test("a figure from the comparative column abstains on its column heading", async () => {
  const { result } = await verifyRecorded("02662226", { mutate: (a) => (line(a, "cash_at_bank").column_heading = "2025") });
  const reason = reasonFor(result, "cash_at_bank");
  assert(reason.startsWith("The period did not match") && reason.includes('"2025"'), reason);
});

test("a column heading with no year cannot establish the period", async () => {
  const { result } = await verifyRecorded("02662226", { mutate: (a) => (line(a, "cash_at_bank").column_heading = "Current year") });
  assert(reasonFor(result, "cash_at_bank").startsWith("The period could not be established"), reasonFor(result, "cash_at_bank"));
});

test("a figure whose period is not the period the accounts are made up to abstains", async () => {
  const read = await firstRead(byNumber("02662226"));
  read.document.periodEnd = "2027-03-31";
  const { result } = await verifyRecorded("02662226", { read });
  assert(reasonFor(result, "cash_at_bank").includes("the accounts are made up to 2027-03-31"), reasonFor(result, "cash_at_bank"));
});

test("column headings: a full date must match, a year must be the period's, and early January may be headed the year before", () => {
  assertEqual(periodFromHeading("31 March 2026", "2026-03-31"), null, "full date");
  assertEqual(periodFromHeading("52-weeks ended 29 December 2024", "2024-12-29"), null, "52 weeks, full date");
  assertEqual(periodFromHeading("2025", "2026-01-01"), null, "a 52-week year ending 1 January headed by the year before");
  assert(periodFromHeading("2025", "2026-03-31") !== null, "last year's column");
  assert(periodFromHeading("31 March 2025", "2026-03-31") !== null, "last year's date");
});

test("a line the second read did not find abstains, and says a single read is never shown", async () => {
  const { result } = await verifyRecorded("02662226", {
    mutate: (a) => Object.assign(line(a, "cash_at_bank"), { status: "abstain", abstain_reason: "not-printed", figure_text: "", sign: "none", excerpt_page: 0 }),
  });
  const reason = reasonFor(result, "cash_at_bank");
  assert(reason.startsWith("The second read did not find this line on pages 9, 10") && reason.includes("never shown"), reason);
});

test("a second read that points outside the excerpt confirms nothing", async () => {
  const { result } = await verifyRecorded("02662226", { mutate: (a) => (line(a, "cash_at_bank").excerpt_page = 7) });
  assert(reasonFor(result, "cash_at_bank").startsWith("The second read of this line was incomplete"), reasonFor(result, "cash_at_bank"));
});

test("a failed balance sheet tie abstains with the amount it was out by", async () => {
  const { result, mapped } = await verifyRecorded("02662226", { mutate: (a) => (tieLine(a, "total_equity").figure_text = "24.1") });
  const reason = reasonFor(result, "net_assets");
  assert(reason.includes("Balance sheet: net assets equal total equity failed"), reason);
  assert(reason.includes("out by £1,000,000"), reason);
  assertEqual(surfaced(mapped, "net_assets"), undefined, "net assets is not shown");
  assert(surfaced(mapped, "total_assets")!.tags.includes("tie-pass"), "total assets, in the tie that held, still shows");
});

test("a tie inside rounding holds: half the last printed digit for each figure in it", async () => {
  const { mapped } = await verifyRecorded("02662226", {
    mutate: (a) => {
      const t = tieLine(a, "total_liabilities");
      t.figure_text = t.figure_text.replace("14.6", "14.65");
    },
  });
  assert(surfaced(mapped, "total_assets")!.tags.includes("tie-pass"), "a 50k gap on £m figures is rounding");
});

test("a tie that cannot run is recorded as not run and is not a failure", async () => {
  const { mapped } = await verifyRecorded("02662226", {
    mutate: (a) => {
      for (const role of ["total_equity", "total_liabilities"]) {
        Object.assign(tieLine(a, role), { status: "abstain", abstain_reason: "not-printed", figure_text: "", sign: "none" });
      }
    },
  });
  const na = surfaced(mapped, "net_assets")!;
  assertEqual(JSON.stringify(na.tags), JSON.stringify(["double-read"]), "agreed, with no tie-pass");
  const ties = na.tag.evidence!.ties;
  assert(ties.length > 0 && ties.every((t) => t.status === "not-run"), "every tie recorded as not run");
  assert(ties[0].detail.startsWith("Not run: total equity is not printed"), ties[0].detail);
});

test("a failed model call abstains every line, and says no second read was made", async () => {
  const { result, mapped } = await verifyRecorded("02662226", { status: 400 });
  assertEqual(mapped.figures.length, 0, "nothing surfaces");
  assert(reasonFor(result, "cash_at_bank").startsWith("No second read was made: the model call failed"), reasonFor(result, "cash_at_bank"));
});

test("a second read that does not match its schema confirms nothing", async () => {
  const { result, mapped } = await verifyRecorded("02662226", { mutate: (a) => delete a.tie_lines });
  assertEqual(mapped.figures.length, 0, "nothing surfaces");
  assert(reasonFor(result, "net_assets").startsWith("The second read came back in a shape"), reasonFor(result, "net_assets"));
});

test("no model configured, cache-only with nothing cached, and a PDF that cannot be cut: no request, every line abstains", async () => {
  const c = byNumber("02662226");
  const read = await firstRead(c);
  const input = { read, pdfBytes: pdf(c), pageCount: c.pageCount };

  const none = await new DoubleReadVerifier({ provider: null, cache: new InMemoryCache() }).verify(input);
  assert(reasonFor(none, "cash_at_bank").includes("no model is configured"), reasonFor(none, "cash_at_bank"));

  const screen = replayProvider(loadJson("verify/02662226-second.json").response);
  const cacheOnly = await new DoubleReadVerifier({ provider: screen.provider, cache: new InMemoryCache(), cacheOnly: true }).verify(input);
  assertEqual(screen.requests.length, 0, "a screen never pays for a second read");
  assert(reasonFor(cacheOnly, "cash_at_bank").includes("may not pay for one"), reasonFor(cacheOnly, "cash_at_bank"));

  const cut = replayProvider(loadJson("verify/02662226-second.json").response);
  const uncuttable = await new DoubleReadVerifier({ provider: cut.provider, cache: new InMemoryCache() }).verify({ ...input, pdfBytes: new Uint8Array(Buffer.from("not a pdf")) });
  assertEqual(cut.requests.length, 0, "the whole filing is never sent instead");
  assert(reasonFor(uncuttable, "cash_at_bank").includes("could not be cut out"), reasonFor(uncuttable, "cash_at_bank"));

  for (const r of [none, cacheOnly, uncuttable]) {
    assertEqual(Object.keys(r.overrides).length, 8, "all eight found lines abstain");
  }
});

suite("visionVerify / a single read never surfaces");

async function bristolRead() {
  return firstRead(byNumber("02662226"));
}

test("no verifier at all: every found line abstains", async () => {
  const read = await bristolRead();
  const m = visionLines(read, unverified(), null);
  assertEqual(m.figures.length, 0, "nothing surfaces");
  assert(m.abstentions.find((a) => a.key === "cash_at_bank")!.reason.startsWith("Seen by one read only"), "and says why");
});

test("the pass-through verifier: every found line abstains", async () => {
  const read = await bristolRead();
  const v = await passThroughVerifier.verify({ read, pdfBytes: new Uint8Array(), pageCount: 28 });
  const applied = applyVerification(read, v);
  assertEqual(visionLines(applied.read, applied.tags, null).figures.length, 0, "nothing surfaces");
});

test("a verifier that tags every line verified without a second read: nothing surfaces", async () => {
  const read = await bristolRead();
  const liar: VisionVerifyResult = {
    verifier: "liar/test",
    lines: Object.fromEntries(BASE_LINE_KEYS.map((k) => [k, { tag: "verified", note: "Trust me." }])) as Record<BaseLineKey, VerifiedLine>,
    overrides: {},
    usage: null,
  };
  const applied = applyVerification(read, liar);
  const m = visionLines(applied.read, applied.tags, null);
  assertEqual(m.figures.length, 0, "a bare verified tag lands nothing");
  assert(m.abstentions.find((a) => a.key === "net_assets")!.reason.includes("named no second read"), "and says so");
});

test("a verifier that pins one line's second read on another: that line does not surface", async () => {
  const { read, result } = await verifyRecorded("02662226");
  const forged = JSON.parse(JSON.stringify(result)) as VisionVerifyResult;
  forged.lines.net_assets = { ...forged.lines.total_assets };
  const applied = applyVerification(read, forged);
  const m = visionLines(applied.read, applied.tags, null);
  assertEqual(m.figures.find((f) => f.key === "net_assets"), undefined, "borrowed evidence lands nothing");
  assert(m.abstentions.find((a) => a.key === "net_assets")!.reason.includes("different figure"), "and says so");
});

test("evidence whose second read disagrees, or whose tie failed, lands nothing", async () => {
  const { read, result } = await verifyRecorded("02662226");
  const disagree = JSON.parse(JSON.stringify(result)) as VisionVerifyResult;
  disagree.lines.cash_at_bank.evidence!.second.value = 1.4;
  const failedTie = JSON.parse(JSON.stringify(result)) as VisionVerifyResult;
  failedTie.lines.net_assets.evidence!.ties[0] = { ...failedTie.lines.net_assets.evidence!.ties[0], status: "fail", detail: "out by £1", outBy: 1 };
  for (const [name, v, key] of [["disagree", disagree, "cash_at_bank"], ["tie", failedTie, "net_assets"]] as const) {
    const applied = applyVerification(read, v);
    const m = visionLines(applied.read, applied.tags, null);
    assertEqual(m.figures.find((f) => f.key === key), undefined, `${name}: not shown`);
  }
});

test("the judgement itself never marks a line verified without a matching second read", async () => {
  const read = await bristolRead();
  const empty = judgeDoubleRead(read, { lines: [], tie_lines: [] }, [9, 10]);
  assert(BASE_LINE_KEYS.every((k) => empty.lines[k].tag !== "verified"), "no second read, no verified line");
});

// --- The engine holds the same rule, whatever reaches it ------------------------

function scanFact(metric: string, value: number, tags: ("double-read" | "tie-pass")[]): Fact {
  return {
    id: `${metric}.FY2026`,
    metric,
    label: metric,
    period: "FY2026",
    kind: "currency",
    value,
    unit: "GBP",
    rung: "R1",
    provenance: {
      sourceId: "ch-live-accounts-vision",
      tag: "Acc",
      documentName: "Annual accounts (scanned PDF)",
      locator: "filing history",
      snippet: "PDF page 9",
      retrievedAt: "2026-09-16",
      contentHash: "x",
      kind: "scan-read",
      page: 9,
      printedText: String(value),
      tags,
    },
    verification: { status: "SINGLE_SOURCE", checks: [] },
    attemptLog: [],
  };
}

test("engine verifier: a scan-read fact without the double-read tag is turned into an abstention", () => {
  const facts: Record<string, Fact> = {
    "cash.FY2026": scanFact("cash", 1_700_000, []),
    "turnover.FY2026": scanFact("turnover", 142_600_000, ["double-read"]),
  };
  runStructuralChecks(facts, "FY2026");
  assertEqual(facts["cash.FY2026"].value, null, "single read abstains");
  assertEqual(facts["cash.FY2026"].rung, "R4", "at R4");
  assert(facts["cash.FY2026"].attemptLog!.at(-1)!.detail.includes("one read only"), "and says why");
  assertEqual(facts["turnover.FY2026"].value, 142_600_000, "a double read stays");
});

test("ladder: a single scan read is not an input to any rung", () => {
  const single = { operatingProfit: scanFact("operatingProfit", 10, []), depreciationAmortisation: scanFact("depreciationAmortisation", 5, []) };
  const r = resolveMetric(ebitdaResolver, { base: single, period: "FY2026" });
  assertEqual(r.rung, "R4", "neither R2 nor the R3 proxy uses a single read");
  const double = { operatingProfit: scanFact("operatingProfit", 10, ["double-read"]), depreciationAmortisation: scanFact("depreciationAmortisation", 5, ["double-read"]) };
  const ok = resolveMetric(ebitdaResolver, { base: double, period: "FY2026" });
  assertEqual(ok.rung, "R2", "double reads synthesise");
  assertEqual(ok.value, 15, "10 + 5");
});
