// test/vision.test.ts
// The vision client for scanned CH accounts: schema validation, abstention on malformed or
// incomplete output, the too-large path making no call, and the versioned cache (a hit makes
// no call; a schema, prompt or model change misses). No network: providers are mocks.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { suite, test, assert, assertEqual } from "./harness";
import { InMemoryCache } from "../lib/cache/cache";
import { AnthropicProvider } from "../lib/llm/providers/anthropic";
import type { LLMCallResult, LLMRequest, StructuredLLMProvider } from "../lib/llm/types";
import { PDFDocument } from "pdf-lib";
import { readScannedAccounts, pdfLimitBreach, countPdfPages, PDF_MAX_PAGES } from "../lib/vision/client";
import { cutPdfPages } from "../lib/vision/pages";
import { carriesPages } from "./pdfPages";
import {
  VISION_SCHEMA,
  VISION_SCHEMA_VERSION,
  parseVisionOutput,
  parsePrintedValue,
  normaliseVisionOutput,
  readPrintedFigure,
  type VisionWireOutput,
  type WireLine,
} from "../lib/vision/schema";
import { PROMPT_VERSION } from "../lib/vision/prompt";
import { promptSchemaHash, visionCacheKey } from "../lib/vision/cache";
import { BASE_LINE_KEYS, type BaseLineKey } from "../lib/vision/types";

function abstainLine(key: BaseLineKey, reason = "not-printed"): WireLine {
  return {
    key,
    status: "abstain",
    abstain_reason: reason,
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

function foundLine(over: Partial<WireLine> = {}): WireLine {
  return {
    key: "turnover",
    status: "found",
    abstain_reason: "",
    printed_label: "Turnover",
    figure_text: "152,300",
    sign: "positive",
    scale_caption: "£'000",
    pdf_page_index: 9,
    printed_page_number: "7",
    statement: "Profit and loss account",
    period_end: "2026-03-31",
    note_reference: "3",
    ...over,
  };
}

// Replace one line of a wire read, keeping its key.
function setLine(w: VisionWireOutput, key: BaseLineKey, line: WireLine): void {
  w.lines = w.lines.map((l) => (l.key === key ? { ...line, key } : l));
}

function wire(): VisionWireOutput {
  const w: VisionWireOutput = {
    document: { company_name_as_printed: "EXAMPLE LIMITED", period_end: "2026-03-31", currency: "GBP", basis: "company" },
    lines: BASE_LINE_KEYS.map((k) => abstainLine(k)),
    debt_note: { status: "abstain", abstain_reason: "no-borrowings", scale_caption: "", pdf_page_indexes: [], facilities: [], maturity_buckets: [] },
  };
  setLine(w, "turnover", foundLine());
  return w;
}

const USAGE = {
  provider: "mock",
  model: "claude-opus-5",
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  durationMs: 1,
  attempts: 1,
  costUsd: 0,
  costGbp: 0,
  priced: true,
  stopReason: "end_turn",
};

class MockVisionProvider implements StructuredLLMProvider {
  readonly name = "mock";
  calls = 0;
  lastRequest: LLMRequest | null = null;
  constructor(readonly model: string, private readonly answer: () => LLMCallResult) {}
  async complete(): Promise<string> {
    throw new Error("not used");
  }
  async send(req: LLMRequest): Promise<LLMCallResult> {
    this.calls++;
    this.lastRequest = req;
    return this.answer();
  }
}

const okWith = (text: string) => (): LLMCallResult => ({ ok: true, text, stopReason: "end_turn", usage: { ...USAGE } });
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"
const input = (over: Partial<{ transactionId: string; pageCount: number; pdfBytes: Uint8Array }> = {}) => ({
  pdfBytes: PDF,
  transactionId: "TX1",
  companyNumber: "00000001",
  pageCount: 28,
  ...over,
});

suite("vision/schema");

test("a well-formed read validates", () => {
  const p = parseVisionOutput(JSON.stringify(wire()));
  assert(p.ok, p.ok ? "" : p.errors.join("; "));
});

test("an extra property, a missing field, a null or a bad enum fails validation", () => {
  const extra = wire() as unknown as Record<string, unknown>;
  extra.comment = "hello";
  assert(!parseVisionOutput(JSON.stringify(extra)).ok, "extra top-level property rejected");

  const missing = wire();
  delete (missing.lines[0] as Partial<WireLine>).scale_caption;
  assert(!parseVisionOutput(JSON.stringify(missing)).ok, "missing field rejected");

  const withNull = wire();
  (withNull.lines[0] as unknown as Record<string, unknown>).figure_text = null;
  assert(!parseVisionOutput(JSON.stringify(withNull)).ok, "null rejected: absent text is an empty string");

  const badEnum = wire();
  (badEnum.lines[0] as unknown as Record<string, unknown>).sign = "up";
  assert(!parseVisionOutput(JSON.stringify(badEnum)).ok, "sign outside the enum rejected");

  const badFacility = wire();
  badFacility.debt_note.facilities = [{ type: "mortgage" } as never];
  assert(!parseVisionOutput(JSON.stringify(badFacility)).ok, "bad facility rejected");
  assert(!parseVisionOutput("not json").ok, "non-JSON rejected");
});

test("the schema sent to the model has no union-typed parameters", () => {
  const unions = (s: unknown): number => {
    if (!s || typeof s !== "object") return 0;
    const o = s as Record<string, unknown>;
    const here = Array.isArray(o.type) || Array.isArray(o.anyOf) ? 1 : 0;
    return here + Object.values(o).reduce<number>((n, v) => n + unions(v), 0);
  };
  assertEqual(unions(VISION_SCHEMA), 0, "the API allows at most 16; this schema uses none");
});

test("a found line without scale, page or period abstains as incomplete", () => {
  const w = wire();
  setLine(w, "turnover", foundLine({ scale_caption: "", period_end: "" }));
  const line = normaliseVisionOutput(w, 28).lines.turnover;
  assertEqual(line.status, "abstain", "downgraded");
  if (line.status === "abstain") assert(line.reason.startsWith("incomplete-found-line"), "reason names incompleteness");
});

test("the value is parsed from the printed figure, and a sign that disagrees abstains", () => {
  const w = wire();
  setLine(w, "operating_profit", foundLine({ figure_text: "(0.7)", sign: "positive" }));
  setLine(w, "net_assets", foundLine({ figure_text: "(1,234)", sign: "negative" }));
  setLine(w, "cash_at_bank", foundLine({ figure_text: "1.7", sign: "positive" }));
  setLine(w, "total_assets", foundLine({ figure_text: "-", sign: "positive" }));
  const read = normaliseVisionOutput(w, 28);
  assertEqual(read.lines.operating_profit.status, "abstain", "bracketed figure reported as positive abstains");
  const na = read.lines.net_assets;
  assert(na.status === "found" && na.value === -1234, "(1,234) parses to -1234");
  const cash = read.lines.cash_at_bank;
  assert(cash.status === "found" && cash.value === 1.7, "1.7 stays 1.7: no scale applied");
  assertEqual(read.lines.total_assets.status, "abstain", "a dash is not a figure");
  assertEqual(readPrintedFigure("£(12.5)m")?.negative, true, "brackets are negative");
  assertEqual(parsePrintedValue(""), null, "empty text has no value");
});

test("a page outside the filing abstains", () => {
  const w = wire();
  setLine(w, "turnover", foundLine({ pdf_page_index: 40 }));
  assertEqual(normaliseVisionOutput(w, 28).lines.turnover.status, "abstain", "page 40 of 28");
});

test("a debt note marked found with nothing in it abstains", () => {
  const w = wire();
  w.debt_note = { ...w.debt_note, status: "found", abstain_reason: "" };
  assertEqual(normaliseVisionOutput(w, 28).debtNote.status, "abstain", "empty note abstains");
});

test("a line returned twice rejects the read; a line not returned abstains", () => {
  const dup = wire();
  dup.lines.push(foundLine({ figure_text: "999" }));
  assert(!parseVisionOutput(JSON.stringify(dup)).ok, "duplicate turnover rejected");

  const short = wire();
  short.lines = short.lines.filter((l) => l.key !== "net_assets");
  const p = parseVisionOutput(JSON.stringify(short));
  assert(p.ok, "a missing line still validates");
  if (p.ok) {
    const line = normaliseVisionOutput(p.value, 28).lines.net_assets;
    assert(line.status === "abstain" && line.reason === "line-not-returned", "missing line abstains");
  }
});

suite("vision/client");

test("malformed model output abstains on every line and is not cached", async () => {
  const provider = new MockVisionProvider("claude-opus-5", okWith('{"lines": "oops"}'));
  const cache = new InMemoryCache();
  const r = await readScannedAccounts(input(), { provider, cache });
  assertEqual(r.outcome, "malformed", "outcome malformed");
  for (const k of BASE_LINE_KEYS) {
    const line = r.lines[k];
    assert(line.status === "abstain" && line.reason === "malformed-output", `${k} abstains as malformed`);
  }
  assertEqual(r.debtNote.status, "abstain", "debt note abstains");
  await readScannedAccounts(input(), { provider, cache });
  assertEqual(provider.calls, 2, "a malformed read is retried next time, not served from cache");
});

test("a refusal abstains on every line with model-refusal", async () => {
  const provider = new MockVisionProvider("claude-opus-5", () => ({ ok: false, failure: { kind: "refusal", detail: "stop_reason refusal" }, usage: null }));
  const r = await readScannedAccounts(input(), { provider, cache: new InMemoryCache() });
  assertEqual(r.outcome, "model-failure", "outcome");
  const line = r.lines.turnover;
  assert(line.status === "abstain" && line.reason === "model-refusal", "reason model-refusal");
});

test("a filing over the page limit is never sent whole: with no page finder it makes no call and abstains", async () => {
  const provider = new MockVisionProvider("claude-opus-5", okWith(JSON.stringify(wire())));
  const r = await readScannedAccounts(input({ pageCount: PDF_MAX_PAGES + 1 }), { provider, cache: new InMemoryCache() });
  assertEqual(provider.calls, 0, "no model call");
  assertEqual(r.outcome, "too-large", "outcome too-large");
  for (const k of BASE_LINE_KEYS) {
    const line = r.lines[k];
    assert(line.status === "abstain" && line.reason.startsWith("page-finding-"), `${k} abstains for page finding`);
  }
  assert(r.debtNote.status === "abstain" && r.debtNote.reason.startsWith("page-finding-"), "debt note abstains for page finding");
  assert(r.failure?.detail.includes("the whole document was not sent") === true, `the failure says so: ${r.failure?.detail}`);
});

test("a filing over the request size limit, or over 100 pages on a 200k model, is too large", () => {
  assert(pdfLimitBreach(25 * 1024 * 1024, 10, "claude-opus-5") !== null, "25 MB grows past 32 MB as base64");
  assertEqual(pdfLimitBreach(4 * 1024 * 1024, 86, "claude-opus-5"), null, "Matalan-sized filing fits");
  assert(pdfLimitBreach(1024, 101, "claude-haiku-4-5") !== null, "101 pages over the 200k-context limit");
  assertEqual(pdfLimitBreach(1024, 600, "claude-opus-5"), null, "600 pages is the limit, not over it");
});

test("a page count nobody could measure is a breach, not a small filing", () => {
  // countPdfPages returns 0 when it cannot tell. 0 used to pass this limit and the 60-page
  // page-finding threshold at once, so an unmeasurable filing was sent whole. A re-saved gold
  // fixture read 26 pages through pdf-lib and 0 through the old "/Type /Page" scan, because its
  // page objects sit inside a compressed object stream.
  assert(pdfLimitBreach(1024, 0, "claude-opus-5") !== null, "0 pages is unknown, so it does not pass");
  assert(pdfLimitBreach(1024, -1, "claude-opus-5") !== null, "a negative count does not pass");
  assert(pdfLimitBreach(1024, 1.5, "claude-opus-5") !== null, "a non-integer count does not pass");
  assert(pdfLimitBreach(1024, Number.NaN, "claude-opus-5") !== null, "NaN does not pass");
  assertEqual(pdfLimitBreach(1024, 1, "claude-opus-5"), null, "one page is a real count and passes");
});

test("countPdfPages reads the page tree, so an object-stream PDF is not counted as zero", async () => {
  // pdf-lib writes object streams by default, which is exactly the shape the old scan missed.
  const doc = await PDFDocument.create({ updateMetadata: false });
  for (let i = 0; i < 26; i += 1) doc.addPage();
  const bytes = await doc.save({ useObjectStreams: true });
  assertEqual(await countPdfPages(bytes), 26, "pdf-lib counts the pages the scan cannot see");
  const scanned = Buffer.from(bytes).toString("latin1").match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? [];
  assertEqual(scanned.length, 0, "and the old scan really does find nothing in this file");
});

test("a file pdf-lib cannot open counts as unknown, however many page markers its bytes contain", async () => {
  // The regex fallback would have counted 3 here and let a file nobody can cut be sent whole.
  const bytes = new Uint8Array(Buffer.from("%PDF-1.4 /Type /Page /Type /Page /Type /Page not really"));
  assertEqual(await countPdfPages(bytes), 0, "unknown");
  assert(pdfLimitBreach(bytes.byteLength, await countPdfPages(bytes), "claude-opus-5") !== null, "so it is a breach");
});

test("a gold scan re-saved with object streams is still counted and cut, page images intact (RS-06)", async () => {
  // The shape a modern producer writes: object streams and a cross-reference stream. The
  // hand-written cutter this replaced gave up on it; pdf-lib reads it like any other.
  const original = new Uint8Array(readFileSync(join(here, "..", "eval", "gold", "fixtures", "uk", "01404552-2024-12-29", "filing.pdf")));
  const modern = await (await PDFDocument.load(original, { updateMetadata: false })).save({ useObjectStreams: true });
  assert(!/\/Type\s*\/Page(?![a-zA-Z])/.test(Buffer.from(modern).toString("latin1")), "no page object is visible in the bytes");
  assertEqual(await countPdfPages(modern), 26, "26 pages");
  const cut = await cutPdfPages(modern, [9, 10, 12]);
  assert(cut !== null, "cut");
  assert(await carriesPages(cut!.bytes, original, [9, 10, 12]), "pages 9, 10 and 12, each image byte for byte the original's");
});

test("the request sends the whole PDF as a base64 document block with the schema", async () => {
  const provider = new MockVisionProvider("claude-opus-5", okWith(JSON.stringify(wire())));
  await readScannedAccounts(input(), { provider, cache: new InMemoryCache() });
  const content = provider.lastRequest?.content;
  assert(Array.isArray(content) && content[0].type === "document", "document block first");
  if (Array.isArray(content) && content[0].type === "document") {
    assertEqual(content[0].source.data, Buffer.from(PDF).toString("base64"), "whole PDF, base64");
  }
  assert(provider.lastRequest?.outputSchema !== undefined, "structured output requested");
});

test("a cache hit makes no second model call", async () => {
  const provider = new MockVisionProvider("claude-opus-5", okWith(JSON.stringify(wire())));
  const cache = new InMemoryCache();
  const first = await readScannedAccounts(input(), { provider, cache });
  const second = await readScannedAccounts(input(), { provider, cache });
  assertEqual(first.outcome, "read", "first read");
  assertEqual(first.fromCache, false, "first is live");
  assertEqual(second.fromCache, true, "second is from cache");
  assertEqual(second.usage, null, "no usage for a call not made");
  assert(second.recordedUsage !== null, "the original call's usage is kept");
  assertEqual(provider.calls, 1, "one model call in total");
  assertEqual(second.lines.turnover.status, "found", "same content");
});

test("a schema version, prompt version or model change misses the cache", async () => {
  const cache = new InMemoryCache();
  const opus = new MockVisionProvider("claude-opus-5", okWith(JSON.stringify(wire())));
  await readScannedAccounts(input(), { provider: opus, cache });
  await readScannedAccounts(input(), { provider: opus, cache, schemaVersion: VISION_SCHEMA_VERSION + 1 });
  assertEqual(opus.calls, 2, "schema version bump misses");
  await readScannedAccounts(input(), { provider: opus, cache, promptVersion: `${PROMPT_VERSION}-next` });
  assertEqual(opus.calls, 3, "prompt version bump misses");
  const sonnet = new MockVisionProvider("claude-sonnet-5", okWith(JSON.stringify(wire())));
  await readScannedAccounts(input(), { provider: sonnet, cache });
  assertEqual(sonnet.calls, 1, "model change misses");
  await readScannedAccounts(input({ transactionId: "TX2" }), { provider: opus, cache });
  assertEqual(opus.calls, 4, "another filing misses");
});

test("the cache key carries schema version, prompt version, hash, model, transaction and page set", () => {
  const key = visionCacheKey({ model: "claude-opus-5", transactionId: "MzU0", pageSet: "all" });
  assert(
    new RegExp(`^vision:v${VISION_SCHEMA_VERSION}:${PROMPT_VERSION}:[0-9a-f]{12}:claude-opus-5:MzU0:all$`).test(key),
    `key shape: ${key}`
  );
  assertEqual(visionCacheKey({ model: "m", transactionId: "t", pageSet: [9, 3, 4] }).endsWith(":3,4,9"), true, "page set sorted");
  assert(promptSchemaHash("prompt a") !== promptSchemaHash("prompt b"), "a prompt edit changes the hash");
});

test("with no provider configured, nothing is sent and every line abstains", async () => {
  const r = await readScannedAccounts(input(), { provider: null, cache: new InMemoryCache() });
  assertEqual(r.outcome, "unconfigured", "outcome unconfigured");
  const line = r.lines.turnover;
  assert(line.status === "abstain" && line.reason === "llm-unconfigured", "reason llm-unconfigured");
});

test("with no provider configured, a read already paid for is served from the cache (WP-BE14)", async () => {
  const cache = new InMemoryCache();
  const paid = new MockVisionProvider("claude-opus-5", okWith(JSON.stringify(wire())));
  await readScannedAccounts(input(), { provider: paid, cache });
  const saved = process.env.LLM_MODEL;
  process.env.LLM_MODEL = "claude-opus-5";
  try {
    const r = await readScannedAccounts(input(), { provider: null, cache });
    assertEqual(r.fromCache, true, "served from the cache");
    assertEqual(r.outcome, "read", "a read, not unconfigured");
    assertEqual(r.usage, null, "no call");
    assertEqual(r.lines.turnover.status, "found", "same content");
    const miss = await readScannedAccounts(input({ transactionId: "TX-NEVER-PAID" }), { provider: null, cache });
    assertEqual(miss.outcome, "unconfigured", "a filing never paid for still abstains");
  } finally {
    if (saved === undefined) delete process.env.LLM_MODEL;
    else process.env.LLM_MODEL = saved;
  }
});

// ---------------------------------------------------------------------------
// Recorded live reads, replayed offline through the real provider with a mocked fetch.
// The fixtures hold the API response text and usage only; no PDF bytes are stored.
// ---------------------------------------------------------------------------

interface VisionFixture {
  companyNumber: string;
  transactionId: string;
  pageCount: number;
  response: { model: string; stop_reason: string; usage: Record<string, number>; content: Array<{ type: string; text: string }> };
}

const here = dirname(fileURLToPath(import.meta.url));
const WHOLE_READ_RECORDINGS_UP_TO = 200;
const loadFixture = (name: string) => JSON.parse(readFileSync(join(here, "fixtures", "vision", name), "utf8")) as VisionFixture;

async function replay(fixture: VisionFixture) {
  let fetches = 0;
  const provider = new AnthropicProvider(
    { provider: "anthropic", model: fixture.response.model, apiKey: "replay", maxTokens: 1024 },
    {
      fetchImpl: async () => {
        fetches++;
        return new Response(JSON.stringify(fixture.response), { status: 200, headers: { "content-type": "application/json" } });
      },
      logUsage: () => {},
    }
  );
  const result = await readScannedAccounts(
    { pdfBytes: PDF, transactionId: fixture.transactionId, companyNumber: fixture.companyNumber, pageCount: fixture.pageCount },
    // These are WP-BE01 recordings of whole-document reads (Matalan is 86 pages), made before
    // page-finding; they replay on the whole-document path they were recorded on.
    { provider, cache: new InMemoryCache(), pageFindingAbovePages: WHOLE_READ_RECORDINGS_UP_TO }
  );
  return { result, fetches };
}

suite("vision/recorded reads");

for (const name of ["bristol-water-02662226.json", "matalan-retail-02103564.json"]) {
  test(`${name}: every base line has page, printed figure, scale and period, or abstains with a reason`, async () => {
    const fixture = loadFixture(name);
    const { result, fetches } = await replay(fixture);
    assertEqual(fetches, 1, "one replayed call");
    assertEqual(result.outcome, "read", "the recorded output validates");
    for (const k of BASE_LINE_KEYS) {
      const line = result.lines[k];
      if (line.status === "found") {
        assert(line.pdfPageIndex >= 1 && line.pdfPageIndex <= fixture.pageCount, `${k} page in range`);
        assert(line.figureText.length > 0 && line.scaleCaption.length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(line.periodEnd), `${k} complete`);
      } else {
        assert(line.reason.length > 0, `${k} abstains with a reason`);
      }
    }
    const d = result.debtNote;
    assert(d.status === "abstain" ? d.reason.length > 0 : d.facilities.length > 0, "debt note returns facilities or abstains");
    assertEqual(result.usage?.inputTokens, fixture.response.usage.input_tokens, "usage read from the recorded response");
  });
}

test("Bristol Water: the irredeemable preference shares sit in their own field, never in borrowings", async () => {
  const { result } = await replay(loadFixture("bristol-water-02662226.json"));
  const pref = result.lines.preference_shares;
  assert(pref.status === "found", "preference shares found");
  if (pref.status === "found") assert(/preference/i.test(pref.printedLabel ?? ""), "labelled as preference shares");
  for (const k of ["borrowings_within_one_year", "borrowings_after_one_year", "shareholder_loans", "interest_payable"] as const) {
    const line = result.lines[k];
    if (line.status === "found") {
      assert(!/preference/i.test(line.printedLabel ?? ""), `${k} does not carry preference shares`);
      if (pref.status === "found") assert(line.figureText !== pref.figureText, `${k} is not the preference share figure`);
    }
  }
  if (result.debtNote.status === "found") {
    assert(result.debtNote.facilities.every((f) => !/preference/i.test(f.nameAsPrinted ?? "")), "no preference share facility");
  }
});
