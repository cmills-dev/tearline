// test/hybridSecondRead.test.ts (WP-OCR3)
// The hybrid second read: OCR first, the model second read only on the lines OCR abstained on.
// OCR reads hand-built page layers through the real OcrSecondReadVerifier. The model second read is
// a scripted verifier that records what it was asked, or the real DoubleReadVerifier with no model
// configured. No test runs OCR, and none calls a model.

import { suite, test, assert, assertEqual } from "./harness";
import { memoryPageSource, type OcrObservation, type OcrPageLayer } from "../lib/ocr/pageLayer";
import { OCR_VERIFIER_NAME } from "../lib/vision/ocrSecondRead";
import { OcrSecondReadVerifier } from "../lib/vision/ocrVerify";
import { HYBRID_ABSTAIN, HybridSecondReadVerifier, ocrDisagrees, restrictRead, type HybridVerifyResult, type OcrChannel } from "../lib/vision/hybridVerify";
import { applyVerification, createVisionVerifier, doubleReadProblem, secondReadMode, DoubleReadVerifier, DOUBLE_READ_VERIFIER_NAME } from "../lib/vision/verify";
import { scaleFromCaption } from "../lib/vision/scale";
import { InMemoryCache } from "../lib/cache/cache";
import {
  BASE_LINE_KEYS,
  type BaseLineKey,
  type FoundLine,
  type VerifiedLine,
  type VisionLine,
  type VisionReadResult,
  type VisionVerifier,
  type VisionVerifyInput,
  type VisionVerifyResult,
} from "../lib/vision/types";

const PERIOD = "2026-03-31";
const TX = "hybrid-test";

// --- Fixtures -----------------------------------------------------------------

const o = (text: string, x0: number, y0: number, x1: number, y1 = y0 + 0.012): OcrObservation => ({ text, confidence: 0.99, box: [x0, y0, x1, y1] });

function row(y: number, label: string, current: string, prior: string): OcrObservation[] {
  return [
    o(label, 0.1, y, 0.1 + 0.012 * label.length),
    o(current, 0.75 - 0.012 * current.length, y, 0.75),
    o(prior, 0.89 - 0.012 * prior.length, y, 0.89),
  ];
}

// A group balance sheet: cash 1.7 this year and 0.3 last year; net assets 25.1 tied to equity.
function balanceSheet(page: number, opts: { caption?: "£m" | "Em" | null; cash?: string } = {}): OcrPageLayer {
  const caption = opts.caption === undefined ? "£m" : opts.caption;
  return {
    engine: "fixture",
    page,
    width: 595,
    height: 842,
    observations: [
      o("Group balance sheet", 0.1, 0.05, 0.35),
      o("at 31 March 2026", 0.1, 0.07, 0.3),
      o("2026", 0.7, 0.15, 0.75),
      o("2025", 0.84, 0.15, 0.89),
      ...(caption ? [o(caption, 0.72, 0.17, 0.75), o(caption, 0.86, 0.17, 0.89)] : []),
      ...row(0.25, "Cash and cash equivalents", opts.cash ?? "1.7", "0.3"),
      ...row(0.3, "Net assets", "25.1", "20.0"),
      ...row(0.35, "Total equity", "25.1", "20.0"),
    ],
  };
}

function found(figureText: string, printedLabel: string, page = 10, scaleCaption = "£m"): FoundLine {
  const negative = figureText.startsWith("(");
  const magnitude = Number(figureText.replace(/[(),]/g, ""));
  return {
    status: "found",
    printedLabel,
    figureText,
    value: negative ? -magnitude : magnitude,
    sign: negative ? "negative" : "positive",
    scaleCaption,
    pdfPageIndex: page,
    printedPageNumber: null,
    statement: "Group balance sheet",
    periodEnd: PERIOD,
    noteReference: null,
  };
}

function firstRead(lines: Partial<Record<BaseLineKey, FoundLine>>): VisionReadResult {
  return {
    outcome: "read",
    fromCache: false,
    cacheKey: "test",
    schemaVersion: 1,
    promptVersion: "p2",
    model: "claude-opus-5",
    transactionId: TX,
    companyNumber: "00000001",
    pageSet: "all",
    document: { companyNameAsPrinted: "Test Group plc", periodEnd: PERIOD, currency: "GBP", basis: "consolidated" },
    lines: Object.fromEntries(BASE_LINE_KEYS.map((k) => [k, lines[k] ?? { status: "abstain", reason: "not-printed" }])) as Record<BaseLineKey, VisionLine>,
    debtNote: { status: "abstain", reason: "not-read" },
    usage: null,
    recordedUsage: null,
  };
}

const USAGE = { inputTokens: 1000, outputTokens: 200 } as unknown as VisionVerifyResult["usage"];

// A model second read that agrees with the first read where told to, and records what it was asked.
function scriptedModel(opts: { confirm?: BaseLineKey[]; confirmAnything?: boolean; throws?: string } = {}) {
  const asked: BaseLineKey[][] = [];
  const verifier: VisionVerifier = {
    name: DOUBLE_READ_VERIFIER_NAME,
    async verify(input: VisionVerifyInput): Promise<VisionVerifyResult> {
      const keys = BASE_LINE_KEYS.filter((k) => input.read.lines[k].status === "found");
      asked.push(keys);
      if (opts.throws) throw new Error(opts.throws);
      const lines = Object.fromEntries(BASE_LINE_KEYS.map((k) => [k, { tag: "not-checked", note: null } as VerifiedLine])) as VisionVerifyResult["lines"];
      const overrides: VisionVerifyResult["overrides"] = {};
      // confirmAnything misbehaves: it confirms every key of the ORIGINAL line set, asked or not.
      const toConfirm = opts.confirmAnything ? BASE_LINE_KEYS : (opts.confirm ?? []);
      for (const k of BASE_LINE_KEYS) {
        const line = (opts.confirmAnything ? ORIGINAL.read : input.read).lines[k];
        if (line?.status !== "found") continue;
        if (toConfirm.includes(k)) lines[k] = modelConfirms(line);
        else {
          lines[k] = { tag: "rejected", note: "The two reads disagreed: model scripted to reject." };
          overrides[k] = { status: "abstain", reason: "The two reads disagreed: model scripted to reject." };
        }
      }
      return { verifier: DOUBLE_READ_VERIFIER_NAME, lines, overrides, usage: USAGE };
    },
  };
  return { verifier, asked };
}
const ORIGINAL: { read: VisionReadResult } = { read: firstRead({}) };

function modelConfirms(line: FoundLine): VerifiedLine {
  const scale = scaleFromCaption(line.scaleCaption)!;
  return {
    tag: "verified",
    note: `Read twice and agreed: "${line.figureText}".`,
    evidence: {
      kind: "double-read",
      verifier: DOUBLE_READ_VERIFIER_NAME,
      first: { figureText: line.figureText, value: line.value, scaleCaption: line.scaleCaption, periodEnd: line.periodEnd, pdfPageIndex: line.pdfPageIndex },
      second: {
        printedLabel: line.printedLabel,
        figureText: line.figureText,
        value: line.value,
        scaleCaption: line.scaleCaption,
        headerScaleCaption: line.scaleCaption,
        currency: "GBP",
        columnHeading: "31 March 2026",
        periodEnd: line.periodEnd,
        pdfPageIndex: line.pdfPageIndex,
        statement: line.statement,
      },
      scale,
      pounds: line.value * scale,
      ties: [],
      basis: { first: "consolidated", second: "consolidated", heading: "Group balance sheet" },
    },
  };
}

function ocrChannel(layers: Record<number, OcrPageLayer>): OcrSecondReadVerifier {
  return new OcrSecondReadVerifier({ pages: memoryPageSource(Object.fromEntries(Object.entries(layers).map(([p, l]) => [`${TX}:${p}`, l]))) });
}

async function hybrid(read: VisionReadResult, layers: Record<number, OcrPageLayer>, model: VisionVerifier, ocr?: OcrChannel): Promise<HybridVerifyResult> {
  ORIGINAL.read = read;
  return new HybridSecondReadVerifier({ ocr: ocr ?? ocrChannel(layers), model }).verify({ read, pdfBytes: new Uint8Array(), pageCount: 20, accountsType: null });
}

const route = (r: HybridVerifyResult, k: BaseLineKey) => r.routes.find((x) => x.key === k)?.route;

// --- Tests --------------------------------------------------------------------

suite("Hybrid second read (WP-OCR3)");

test("OCR confirms: the line stands on OCR's evidence and no paid call is made", async () => {
  const read = firstRead({ cash_at_bank: found("1.7", "Cash and cash equivalents"), net_assets: found("25.1", "Net assets") });
  const m = scriptedModel();
  const r = await hybrid(read, { 10: balanceSheet(10) }, m.verifier);
  assertEqual(r.lines.cash_at_bank.tag, "verified", "cash confirmed");
  assertEqual(r.lines.cash_at_bank.evidence!.verifier, OCR_VERIFIER_NAME, "OCR's own evidence");
  assertEqual(r.lines.net_assets.tag, "verified", "net assets confirmed");
  assertEqual(m.asked.length, 0, "the model was never called");
  assertEqual(r.sentToModel.length, 0, "nothing sent");
  assertEqual(r.usage, null, "no usage");
  assertEqual(route(r, "cash_at_bank"), "ocr-confirmed", "route");
  assert(r.verifier.startsWith("hybrid/") && r.verifier.includes(OCR_VERIFIER_NAME) && r.verifier.includes(DOUBLE_READ_VERIFIER_NAME), r.verifier);
  const applied = applyVerification(read, r);
  assertEqual(doubleReadProblem(read.lines.cash_at_bank as FoundLine, applied.tags.cash_at_bank), null, "lands");
});

test("OCR abstains (no caption on its page): only that line, and only its page, goes to the model, which confirms it", async () => {
  const read = firstRead({ cash_at_bank: found("1.7", "Cash and cash equivalents", 10), net_assets: found("25.1", "Net assets", 11) });
  const m = scriptedModel({ confirm: ["net_assets"] });
  const r = await hybrid(read, { 10: balanceSheet(10), 11: balanceSheet(11, { caption: null }) }, m.verifier);
  assertEqual(r.lines.cash_at_bank.evidence?.verifier, OCR_VERIFIER_NAME, "cash on OCR");
  assertEqual(m.asked.length, 1, "one paid call");
  assertEqual(m.asked[0].join(","), "net_assets", "the model was asked only about net assets");
  assertEqual(r.sentToModel.join(","), "net_assets", "recorded");
  assertEqual(r.lines.net_assets.tag, "verified", "the model confirmed");
  assertEqual(r.lines.net_assets.evidence!.verifier, DOUBLE_READ_VERIFIER_NAME, "on the model's evidence");
  assert(/Local OCR read the same figure, "25.1"/.test(r.lines.net_assets.note ?? ""), r.lines.net_assets.note ?? "");
  assertEqual(r.usage, USAGE, "the model's usage is reported");
  assertEqual(route(r, "net_assets"), "model", "route");
  const applied = applyVerification(read, r);
  assertEqual(doubleReadProblem(read.lines.net_assets as FoundLine, applied.tags.net_assets), null, "lands");
});

test("OCR abstains and the model rejects: the line abstains with the model's reason and OCR's", async () => {
  const read = firstRead({ turnover: found("10.0", "Revenue") });
  const m = scriptedModel();
  const r = await hybrid(read, { 10: balanceSheet(10) }, m.verifier);
  assertEqual(m.asked[0].join(","), "turnover", "sent");
  assertEqual(r.lines.turnover.tag, "rejected", "rejected");
  const why = r.overrides.turnover!.reason;
  assert(/model scripted to reject/.test(why) && /Local OCR abstained first: .*label-not-found/.test(why), why);
  assertEqual(route(r, "turnover"), "model", "route");
});

test("OCR reads a different figure (the comparative column): abstains as a disagreement, no paid call", async () => {
  const read = firstRead({ cash_at_bank: found("0.3", "Cash and cash equivalents") });
  const m = scriptedModel({ confirm: ["cash_at_bank"] });
  const r = await hybrid(read, { 10: balanceSheet(10) }, m.verifier);
  assertEqual(m.asked.length, 0, "no model call");
  assertEqual(r.lines.cash_at_bank.tag, "rejected", "rejected");
  const why = r.overrides.cash_at_bank!.reason;
  assert(why.startsWith(HYBRID_ABSTAIN.disagree) && /"1.7"/.test(why) && /"0.3"/.test(why), why);
  assertEqual(route(r, "cash_at_bank"), "disagree", "route");
});

test("same digits, opposite sign: a disagreement", async () => {
  const r = await hybrid(firstRead({ cash_at_bank: found("(1.7)", "Cash and cash equivalents") }), { 10: balanceSheet(10) }, scriptedModel().verifier);
  assertEqual(route(r, "cash_at_bank"), "disagree", "route");
});

test("same digits under an 'Em' caption OCR cannot place is not a disagreement: the model decides", async () => {
  const read = firstRead({ cash_at_bank: found("1.7", "Cash and cash equivalents") });
  const m = scriptedModel({ confirm: ["cash_at_bank"] });
  const r = await hybrid(read, { 10: balanceSheet(10, { caption: "Em" }) }, m.verifier);
  assertEqual(m.asked.length, 1, "sent to the model");
  assertEqual(r.lines.cash_at_bank.tag, "verified", "the model confirmed");
});

test("an unreadable OCR cell is never a disagreement: the model decides", async () => {
  const read = firstRead({ cash_at_bank: found("1.7", "Cash and cash equivalents") });
  const m = scriptedModel();
  const r = await hybrid(read, { 10: balanceSheet(10, { cash: "1.7€ł" }) }, m.verifier);
  assertEqual(route(r, "cash_at_bank"), "model", "route");
  assert(/Local OCR abstained first/.test(r.overrides.cash_at_bank!.reason), r.overrides.cash_at_bank!.reason);
});

test("no OCR layer for a page: its lines go to the model", async () => {
  const read = firstRead({ cash_at_bank: found("1.7", "Cash and cash equivalents", 12) });
  const m = scriptedModel({ confirm: ["cash_at_bank"] });
  const r = await hybrid(read, { 10: balanceSheet(10) }, m.verifier);
  assertEqual(m.asked[0].join(","), "cash_at_bank", "sent");
  assertEqual(r.lines.cash_at_bank.tag, "verified", "confirmed by the model");
});

test("the model can neither confirm nor reject a line OCR decided", async () => {
  // OCR confirms cash on page 10, disagrees on net assets' comparative on page 10, and abstains
  // on turnover. The model here confirms everything the first read found, asked or not.
  const read = firstRead({ cash_at_bank: found("1.7", "Cash and cash equivalents"), net_assets: found("20.0", "Net assets"), turnover: found("10.0", "Revenue") });
  const m = scriptedModel({ confirmAnything: true });
  const r = await hybrid(read, { 10: balanceSheet(10) }, m.verifier);
  assertEqual(m.asked[0].join(","), "turnover", "asked only about turnover");
  assertEqual(r.lines.cash_at_bank.evidence!.verifier, OCR_VERIFIER_NAME, "cash keeps OCR's evidence");
  assertEqual(r.lines.net_assets.tag, "rejected", "the disagreement stands");
  assert(r.overrides.net_assets!.reason.startsWith(HYBRID_ABSTAIN.disagree), r.overrides.net_assets!.reason);
  assertEqual(r.lines.turnover.tag, "verified", "the model decided turnover");
});

test("the model call throws: the lines sent to it abstain with a named reason, OCR's confirmations stand", async () => {
  const read = firstRead({ cash_at_bank: found("1.7", "Cash and cash equivalents"), turnover: found("10.0", "Revenue") });
  const r = await hybrid(read, { 10: balanceSheet(10) }, scriptedModel({ throws: "socket hang up" }).verifier);
  assertEqual(r.lines.cash_at_bank.tag, "verified", "cash stands");
  assertEqual(r.lines.turnover.tag, "rejected", "turnover abstains");
  assert(r.overrides.turnover!.reason.startsWith(HYBRID_ABSTAIN.modelFailed) && /socket hang up/.test(r.overrides.turnover!.reason), r.overrides.turnover!.reason);
  assertEqual(route(r, "turnover"), "model-failed", "route");
});

test("no model configured (the real DoubleReadVerifier): OCR's confirmations land, the rest abstain", async () => {
  const read = firstRead({ cash_at_bank: found("1.7", "Cash and cash equivalents"), turnover: found("10.0", "Revenue") });
  const model = new DoubleReadVerifier({ provider: null, cache: new InMemoryCache() });
  const r = await hybrid(read, { 10: balanceSheet(10) }, model);
  assertEqual(r.lines.cash_at_bank.tag, "verified", "cash stands");
  assertEqual(r.lines.turnover.tag, "rejected", "turnover abstains");
  assert(/No second read/.test(r.overrides.turnover!.reason), r.overrides.turnover!.reason);
  assertEqual(route(r, "turnover"), "model-failed", "route");
});

test("OCR itself throws: every line goes to the model", async () => {
  const read = firstRead({ cash_at_bank: found("1.7", "Cash and cash equivalents") });
  const broken: OcrChannel = { name: OCR_VERIFIER_NAME, verify: async () => { throw new Error("cache unreadable"); } };
  const m = scriptedModel({ confirm: ["cash_at_bank"] });
  const r = await hybrid(read, {}, m.verifier, broken);
  assertEqual(m.asked[0].join(","), "cash_at_bank", "sent");
  assertEqual(r.lines.cash_at_bank.tag, "verified", "the model confirmed");
  assert(/OCR failed: cache unreadable/.test(r.lines.cash_at_bank.note ?? ""), r.lines.cash_at_bank.note ?? "");
});

test("a read with no found lines: nothing is sent and every line is not-checked", async () => {
  const m = scriptedModel();
  const r = await hybrid(firstRead({}), { 10: balanceSheet(10) }, m.verifier);
  assertEqual(m.asked.length, 0, "no call");
  assert(BASE_LINE_KEYS.every((k) => r.lines[k].tag === "not-checked"), "not-checked");
  assertEqual(Object.keys(r.overrides).length, 0, "no overrides");
});

test("every line carries a tag, and every rejection an override", async () => {
  const read = firstRead({ cash_at_bank: found("0.3", "Cash and cash equivalents"), turnover: found("10.0", "Revenue"), net_assets: found("25.1", "Net assets") });
  const r = await hybrid(read, { 10: balanceSheet(10) }, scriptedModel().verifier);
  for (const k of BASE_LINE_KEYS) {
    assert(r.lines[k] !== undefined, `tag for ${k}`);
    assertEqual(r.lines[k].tag === "rejected", r.overrides[k] !== undefined, `override matches tag for ${k}`);
  }
});

test("ocrDisagrees: only a figure OCR read, with scale compared only where both captions say", () => {
  const line = found("1.7", "Cash");
  const d = (ocr: string | null) => ({ key: "cash_at_bank" as BaseLineKey, page: 10, first: "1.7", ocr, code: null, detail: "" });
  assertEqual(ocrDisagrees(line, undefined, null), false, "no diagnostic");
  assertEqual(ocrDisagrees(line, d(null), null), false, "OCR placed nothing");
  assertEqual(ocrDisagrees(line, d("ł€"), "£m"), false, "unparseable cell");
  assertEqual(ocrDisagrees(line, d("1.7"), "Em"), false, "same digits, OCR scale unknown");
  assertEqual(ocrDisagrees(line, d("1.7"), "£'000"), true, "same digits, different known scale");
  assertEqual(ocrDisagrees(line, d("1,700"), "£'000"), false, "same pounds under another caption");
  assertEqual(ocrDisagrees(line, d("1.8"), null), true, "different digits");
});

test("restrictRead leaves only the named lines found and changes nothing else", () => {
  const read = firstRead({ cash_at_bank: found("1.7", "Cash"), turnover: found("10.0", "Revenue") });
  const r = restrictRead(read, ["turnover"]);
  assertEqual(r.lines.cash_at_bank.status, "abstain", "cash taken out");
  assertEqual(r.lines.turnover, read.lines.turnover, "turnover untouched");
  assertEqual(r.transactionId, read.transactionId, "same filing");
  assertEqual(read.lines.cash_at_bank.status, "found", "the original is not mutated");
});

test("the flag: VISION_SECOND_READ=hybrid selects the hybrid; model stays the default", () => {
  assertEqual(secondReadMode(undefined), "model", "unset");
  assertEqual(secondReadMode(" Hybrid "), "hybrid", "hybrid");
  assertEqual(secondReadMode("ocr"), "ocr", "ocr kept");
  assertEqual(secondReadMode("hybird"), "model", "a typo falls back to the model");
  assert(createVisionVerifier({ provider: null }, "hybrid") instanceof HybridSecondReadVerifier, "hybrid verifier");
  assertEqual(createVisionVerifier({ provider: null }, "model").name, DOUBLE_READ_VERIFIER_NAME, "model verifier");
});
