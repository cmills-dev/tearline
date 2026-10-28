// test/visionLive.test.ts
// The live Companies House path with vision wired in (WP-BE04). No network: global fetch is
// mocked and the model provider is a stub. The PDF is a REAL frozen Companies House scan
// (eval/gold/fixtures/uk/02662226-2026-03-31/filing.pdf, 28 pages, image only), so the
// scan-versus-text-layer decision is made against a real document rather than a sketch.
//
// The figures in the stubbed read are invented for this test. No assertion here rests on a
// WP-BE03 gold figure, because those are agent-keyed candidates until Cam's spot check.
//
// Since WP-BE05 the live path runs the double read by default, so the stub answers two kinds of
// request: the first read (the vision schema) and the second read (the second-read schema, which
// it answers from the same invented figures on the pages it was sent). The WP-BE05 rules
// themselves are tested in test/visionVerify.test.ts against recorded reads.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { suite, test, assert, assertEqual } from "./harness";
import { InMemoryCache } from "../lib/cache/cache";
import { scaleFromCaption } from "../lib/vision/scale";
import { applyVerification, DoubleReadVerifier, passThroughVerifier } from "../lib/vision/verify";
import { SECOND_READ_SCHEMA, type SecondReadWire } from "../lib/vision/secondRead";
import { FACILITY_READ_SCHEMA, type FacilityReadWire } from "../lib/vision/capitalStructure";
import { TIE_ROLES } from "../lib/vision/secondRead";
import { pdfPageCount } from "../lib/vision/pages";
import { classifyPdf, extractFinancialsFromText, pdfToText } from "../lib/sources/pdfAccounts";
import {
  buildLiveFactManifest,
  mapLiveToManifest,
  type BuildLiveOptions,
} from "../lib/sources/companiesHouseLive";
import type { ChargesList, CompanyProfile } from "../lib/sources/companiesHouse";
import type { FactManifest } from "../lib/engine/types";
import type { LLMCallResult, LLMRequest, StructuredLLMProvider } from "../lib/llm/types";
import {
  BASE_LINE_KEYS,
  type BaseLineKey,
  type StageEvent,
  type VisionVerifier,
  type VisionVerifyResult,
} from "../lib/vision/types";
import type { VisionWireOutput, WireLine } from "../lib/vision/schema";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCAN_PDF = new Uint8Array(
  readFileSync(join(HERE, "..", "eval", "gold", "fixtures", "uk", "02662226-2026-03-31", "filing.pdf"))
);

// --- Register payloads -------------------------------------------------------

const NUMBER = "02662226";

const PROFILE: CompanyProfile = {
  company_name: "BRISTOL WATER PLC",
  company_number: NUMBER,
  company_status: "active",
  date_of_creation: "1991-10-18",
  type: "plc",
  jurisdiction: "england-wales",
  sic_codes: ["36000"],
  registered_office_address: { address_line_1: "Bridgwater Road", locality: "Bristol", country: "England" },
  accounts: {
    accounting_reference_date: { day: "31", month: "03" },
    // The register says "filleted" here on purpose: the filing description says full, and the
    // filing must win (audit finding 8). Full, not group, because the stubbed read is Bristol
    // Water's company-only accounts (its gold meta.json says "full"); a group filing read on a
    // company basis now abstains under the basis check (WP-BE18, test/basisCheck.test.ts).
    last_accounts: { made_up_to: "2026-03-31", type: "filleted" },
    next_due: "2026-12-31",
  },
};

const NO_CHARGES: ChargesList = { total_count: 0, unfiled_count: 0, items: [] };

const META_URL = "https://document-api.company-information.service.gov.uk/document/FROZEN";
const CONTENT_URL = `${META_URL}/content`;

// The newest accounts-CATEGORY filing is an AA01 (change of accounting reference date). It has
// no figures, and the old items_per_page=1 call would have stopped there (audit finding 6).
let FILING_HISTORY: { total_count: number; items: unknown[] } = {
  total_count: 3,
  items: [
    {
      transaction_id: "AA01TX",
      category: "accounts",
      type: "AA01",
      description: "change-account-reference-date-company-previous-extend",
      date: "2026-09-14",
      links: { document_metadata: `${META_URL}-aa01` },
    },
    {
      transaction_id: "AATX",
      category: "accounts",
      type: "AA",
      description: "accounts-with-accounts-type-full",
      description_values: { made_up_date: "2026-03-31" },
      date: "2026-09-11",
      pages: 28,
      links: { document_metadata: META_URL },
    },
    {
      transaction_id: "OLDTX",
      category: "accounts",
      type: "AA",
      description: "accounts-with-accounts-type-full",
      description_values: { made_up_date: "2025-03-31" },
      date: "2025-09-10",
      pages: 26,
      links: { document_metadata: `${META_URL}-old` },
    },
  ],
};

const DOC_METADATA = { links: { document: CONTENT_URL }, resources: { "application/pdf": { content_type: "application/pdf" } } };

// --- Fetch mock --------------------------------------------------------------

function jsonResponse(data: unknown, status = 200): Response {
  const text = JSON.stringify(data);
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => data,
    text: async () => text,
    headers: new Headers({ "content-length": String(text.length) }),
    body: null,
  } as unknown as Response;
}

function pdfResponse(bytes: Uint8Array): Response {
  return {
    status: 200,
    ok: true,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    headers: new Headers({ "content-length": String(bytes.byteLength) }),
    body: null,
  } as unknown as Response;
}

let documentFetches = 0;

function installFetchMock(): void {
  documentFetches = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === CONTENT_URL) {
      documentFetches++;
      return pdfResponse(SCAN_PDF);
    }
    if (url.startsWith(META_URL)) return jsonResponse(DOC_METADATA);
    if (url.includes("/filing-history")) return jsonResponse(FILING_HISTORY);
    if (url.includes("/charges")) return jsonResponse(NO_CHARGES);
    if (url.includes("/insolvency")) return jsonResponse({ errors: [] }, 404);
    if (url.includes("gleif")) return jsonResponse({ data: [] });
    if (url.includes("/company/")) return jsonResponse(PROFILE);
    return jsonResponse({}, 404);
  }) as typeof fetch;
}

// --- The stubbed read --------------------------------------------------------

function abstainLine(key: BaseLineKey, reason: string): WireLine {
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

function found(key: BaseLineKey, over: Partial<WireLine>): WireLine {
  return {
    key,
    status: "found",
    abstain_reason: "",
    printed_label: "",
    figure_text: "",
    sign: "positive",
    scale_caption: "£m",
    pdf_page_index: 9,
    printed_page_number: "7",
    statement: "Statement of financial position",
    period_end: "2026-03-31",
    note_reference: "",
    ...over,
  };
}

// Invented figures, chosen so each rule under test is visible in the answer:
//   turnover      positive, £m, one decimal
//   operating     a LOSS in brackets, which must stay negative
//   creditors     a liability in brackets, which must land as a positive balance
//   borrowings    split by maturity, which the ladder adds at R2
//   total assets  not printed, which must abstain with the model's own reason
const WIRE: VisionWireOutput = {
  document: { company_name_as_printed: "BRISTOL WATER PLC", period_end: "2026-03-31", currency: "GBP", basis: "company" },
  lines: [
    ...BASE_LINE_KEYS.map((k) => abstainLine(k, "not-printed")),
    found("turnover", { printed_label: "Turnover", figure_text: "142.6", statement: "Income statement", note_reference: "2" }),
    found("operating_profit", {
      printed_label: "Operating loss",
      figure_text: "(0.7)",
      sign: "negative",
      statement: "Income statement",
    }),
    found("depreciation_amortisation", { printed_label: "Depreciation", figure_text: "(21.4)", sign: "negative", statement: "Cash flow statement", pdf_page_index: 12 }),
    found("cash_at_bank", { printed_label: "Cash at bank and in hand", figure_text: "1.7", pdf_page_index: 10 }),
    found("borrowings_within_one_year", { printed_label: "Bank loans", figure_text: "(2.5)", sign: "negative", pdf_page_index: 10, note_reference: "14" }),
    found("borrowings_after_one_year", { printed_label: "Bank loans", figure_text: "(30.0)", sign: "negative", pdf_page_index: 10, note_reference: "14" }),
    found("interest_payable", { printed_label: "Interest payable and similar expenses", figure_text: "(1.1)", sign: "negative", statement: "Income statement" }),
    found("net_assets", { printed_label: "Net liabilities", figure_text: "(4.9)", sign: "negative", pdf_page_index: 10 }),
    found("net_current_liabilities", { printed_label: "Net current liabilities", figure_text: "(8.3)", sign: "negative", pdf_page_index: 10 }),
    found("current_liabilities", { printed_label: "Creditors: amounts falling due within one year", figure_text: "(19.9)", sign: "negative", pdf_page_index: 10 }),
  ]
    // The later entry for a key wins, so the abstain skeleton above is the default.
    .reduce<WireLine[]>((acc, line) => {
      const i = acc.findIndex((l) => l.key === line.key);
      if (i >= 0) acc[i] = line;
      else acc.push(line);
      return acc;
    }, []),
  debt_note: {
    status: "found",
    abstain_reason: "",
    scale_caption: "£m",
    pdf_page_indexes: [21],
    facilities: [
      {
        name_as_printed: "Term loan 2031",
        type: "term_loan",
        lender: "A lender",
        amount_drawn_text: "30.0",
        facility_size_text: "30.0",
        currency: "GBP",
        maturity: "2031",
        rate_or_margin: "",
        security: "",
        ranking: "",
        pdf_page_index: 21,
      },
    ],
    maturity_buckets: [],
  },
};

const USAGE = {
  provider: "mock",
  model: "claude-opus-5",
  inputTokens: 44_828,
  outputTokens: 884,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  durationMs: 1,
  attempts: 1,
  costUsd: 0,
  costGbp: 0,
  priced: true,
  stopReason: "end_turn",
};

// The second read of the stubbed figures: every found line again, with the statement header
// caption and column heading a real page prints, on the page of the excerpt it was sent.
function secondWire(): SecondReadWire {
  const foundLines = WIRE.lines.filter((l) => l.status === "found");
  const pages = [...new Set(foundLines.map((l) => l.pdf_page_index))].sort((a, b) => a - b);
  return {
    lines: foundLines.map((l) => ({
      key: l.key,
      status: "found",
      abstain_reason: "",
      printed_label: l.printed_label,
      figure_text: l.figure_text,
      sign: l.sign,
      scale_caption: l.scale_caption,
      header_scale_caption: l.scale_caption,
      header_currency: "£",
      column_heading: "2026",
      period_end: l.period_end,
      excerpt_page: pages.indexOf(l.pdf_page_index) + 1,
      statement: l.statement,
      // What the page says about whose statement it is, read from its heading (WP-BE18).
      basis: /consolidated|group/i.test(l.statement) ? ("consolidated" as const) : ("none" as const),
      basis_text: /consolidated|group/i.test(l.statement) ? l.statement : "",
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

// The debt note's second read (WP-BE16), seeing the same term loan the first read did.
function facilityWire(): FacilityReadWire {
  return {
    note: {
      status: "found",
      abstain_reason: "",
      heading: "21. Borrowings",
      header_scale_caption: "£m",
      header_currency: "£",
      basis: "none",
      basis_text: "",
    },
    facilities: [
      {
        name_as_printed: "Term loan 2031",
        type: "term_loan",
        lender: "A lender",
        amount_drawn_text: "30.0",
        drawn_column_heading: "2026",
        drawn_period_end: "2026-03-31",
        facility_size_text: "30.0",
        maturity: "2031",
        rate_or_margin: "",
        security: "",
        ranking_text: "",
        excerpt_page: 1,
      },
    ],
  };
}

class MockVisionProvider implements StructuredLLMProvider {
  readonly name = "mock";
  readonly model = "claude-opus-5";
  calls = 0;
  firstReads = 0;
  secondReads = 0;
  facilityReads = 0;
  lastFacilityRequest: LLMRequest | null = null;
  lastRequest: LLMRequest | null = null;
  lastSecondRequest: LLMRequest | null = null;
  async complete(): Promise<string> {
    throw new Error("not used");
  }
  async send(req: LLMRequest): Promise<LLMCallResult> {
    this.calls++;
    if (req.outputSchema === SECOND_READ_SCHEMA) {
      this.secondReads++;
      this.lastSecondRequest = req;
      return { ok: true, text: JSON.stringify(secondWire()), stopReason: "end_turn", usage: { ...USAGE } };
    }
    if (req.outputSchema === FACILITY_READ_SCHEMA) {
      this.facilityReads++;
      this.lastFacilityRequest = req;
      return { ok: true, text: JSON.stringify(facilityWire()), stopReason: "end_turn", usage: { ...USAGE } };
    }
    this.firstReads++;
    this.lastRequest = req;
    return { ok: true, text: JSON.stringify(WIRE), stopReason: "end_turn", usage: { ...USAGE } };
  }
}

// A verifier that runs the real double read and then rejects one line, to prove an override
// abstains it rather than rewriting it, and leaves the agreed lines alone.
function rejectingVerifier(provider: StructuredLLMProvider): VisionVerifier {
  const inner = new DoubleReadVerifier({ provider, cache: new InMemoryCache() });
  return {
    name: "rejecting/test",
    async verify(input): Promise<VisionVerifyResult> {
      const result = await inner.verify(input);
      result.lines.cash_at_bank = { tag: "rejected", note: "The second read saw a different figure." };
      result.overrides.cash_at_bank = { status: "abstain", reason: "verifier-disagreed" };
      return result;
    },
  };
}

// --- Async setup, awaited by the runner before run() -------------------------

let manifest: FactManifest;
let provider: MockVisionProvider;
let stages: StageEvent[] = [];
let rejected: FactManifest;
let cacheOnlyManifest: FactManifest;
let cacheOnlyProvider: MockVisionProvider;
let cacheHitManifest: FactManifest;
let cacheHitProvider: MockVisionProvider;
let tooLarge: FactManifest;
let passThrough: FactManifest;
let firstRunDocumentBytes = 0;
let tooLargeProvider: MockVisionProvider;
let scanText = "";
let throwingCallbackManifest: FactManifest;
let downloadsAfterFirstRun = 0;
let firstRunDownloads = 0;

async function build(opts: BuildLiveOptions): Promise<FactManifest> {
  return buildLiveFactManifest(NUMBER, opts);
}

export async function registerVisionLiveTests(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.CH_API_KEY;
  installFetchMock();
  process.env.CH_API_KEY = "demo-key";

  // Each run gets its own cache, so a hit is only ever one this test put there.
  provider = new MockVisionProvider();
  manifest = await build({
    visionDeps: { provider, cache: new InMemoryCache() },
    onStage: (e) => stages.push(e),
  });
  downloadsAfterFirstRun = documentFetches;
  {
    const content = provider.lastRequest?.content;
    const doc = Array.isArray(content) ? content.find((c) => c.type === "document") : undefined;
    firstRunDocumentBytes = doc && doc.type === "document" ? Buffer.from(doc.source.data, "base64").length : 0;
  }

  const rejectingProvider = new MockVisionProvider();
  rejected = await build({
    verifier: rejectingVerifier(rejectingProvider),
    visionDeps: { provider: rejectingProvider, cache: new InMemoryCache() },
  });

  // The WP-BE04 pass-through, which makes no second read: since WP-BE05 nothing it passes shows.
  passThrough = await build({
    verifier: passThroughVerifier,
    visionDeps: { provider: new MockVisionProvider(), cache: new InMemoryCache() },
  });

  // Cache-only with an empty cache: abstain, no model call.
  cacheOnlyProvider = new MockVisionProvider();
  cacheOnlyManifest = await build({
    vision: "cache-only",
    visionDeps: { provider: cacheOnlyProvider, cache: new InMemoryCache() },
  });

  // Cache-only with the read already cached: the figures come back, still no model call.
  const primed = new InMemoryCache();
  cacheHitProvider = new MockVisionProvider();
  const warm = new MockVisionProvider();
  await build({ visionDeps: { provider: warm, cache: primed } });
  cacheHitManifest = await build({ vision: "cache-only", visionDeps: { provider: cacheHitProvider, cache: primed } });

  // Over the page limit: no call at all, every line abstains with the page-finding reason. The
  // register itself says how many pages the filing has, so this is the real path, not a seam.
  const realHistory = FILING_HISTORY;
  FILING_HISTORY = {
    total_count: 1,
    items: [
      {
        transaction_id: "HUGETX",
        category: "accounts",
        type: "AA",
        description: "accounts-with-accounts-type-full",
        description_values: { made_up_date: "2026-03-31" },
        date: "2026-09-11",
        pages: 900,
        links: { document_metadata: META_URL },
      },
    ],
  };
  tooLargeProvider = new MockVisionProvider();
  tooLarge = await build({ visionDeps: { provider: tooLargeProvider, cache: new InMemoryCache() } });
  FILING_HISTORY = realHistory;

  // A progress display that falls over must not be able to fail a run.
  throwingCallbackManifest = await build({
    visionDeps: { provider: new MockVisionProvider(), cache: new InMemoryCache() },
    onStage: () => {
      throw new Error("a progress display fell over");
    },
  });

  scanText = await pdfToText(SCAN_PDF);
  firstRunDownloads = downloadsAfterFirstRun;

  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.CH_API_KEY;
  else process.env.CH_API_KEY = originalKey;

  registerCases();
}

// --- Assertions --------------------------------------------------------------

const PK = "FY2026";
const fact = (m: FactManifest, metric: string) => m.facts[`${metric}.${PK}`];

function registerCases(): void {
  suite("visionLive / a Companies House scan is read, not parsed");

  test("the frozen Companies House filing really is an image-only scan", () => {
    assertEqual(classifyPdf(SCAN_PDF, scanText, 28), "scan", "tiff2pdf filing classified as a scan");
    assert(scanText.trim().length < 400, `text layer is empty (${scanText.trim().length} characters)`);
  });

  test("reading the text layer leaves the PDF bytes intact for the vision reader", async () => {
    const copy = SCAN_PDF.slice();
    await pdfToText(copy);
    assertEqual(copy.length, SCAN_PDF.length, "pdf.js must not detach the caller's buffer");
    assertEqual(firstRunDocumentBytes, SCAN_PDF.length, "the first read was sent the whole filing, not an emptied buffer");
  });

  test("the text-layer extractor is not what produced the figures", () => {
    assertEqual(extractFinancialsFromText(scanText, "pdf"), null, "the text layer yields nothing");
    const src = fact(manifest, "turnover").provenance!.sourceId;
    assertEqual(src, "ch-live-accounts-vision", "turnover is cited to the vision read");
  });

  test("one first read and one second read, and the PDF was fetched once", () => {
    assertEqual(provider.firstReads, 1, "exactly one first read");
    assertEqual(provider.secondReads, 1, "exactly one second read");
    assertEqual(firstRunDownloads, 1, "the PDF was downloaded once");
    const content = provider.lastRequest!.content;
    assert(Array.isArray(content) && content.some((c) => c.type === "document"), "the PDF went as a document block");
  });

  test("the second read on the live path is sent only the cited pages (9, 10 and 12 of 28)", async () => {
    const content = provider.lastSecondRequest!.content;
    const doc = Array.isArray(content) ? content.find((c) => c.type === "document") : undefined;
    if (!doc || doc.type !== "document") throw new Error("the excerpt went as a document block");
    const bytes = new Uint8Array(Buffer.from(doc.source.data, "base64"));
    assertEqual(await pdfPageCount(bytes), 3, "three pages, not twenty-eight");
  });

  suite("visionLive / every base line answers");

  test("each base line is either a figure or an abstention with a reason", () => {
    for (const key of BASE_LINE_KEYS) {
      const line = manifest.facts[`${keyMetric(key)}.${PK}`];
      assert(!!line, `${key} has a fact`);
      if (line.value === null) {
        assertEqual(line.rung, "R4", `${key} abstains at R4`);
        assert(!!line.attemptLog?.[0]?.detail, `${key} says why it abstained`);
      } else {
        assertEqual(line.rung, "R1", `${key} is reported`);
      }
    }
  });

  test("a found line cites page, printed text and scale, and carries its verification tag", () => {
    const snippet = fact(manifest, "cash").provenance!.snippet;
    assert(snippet.includes("PDF page 10"), `page in the citation: ${snippet}`);
    assert(snippet.includes('printed as "1.7"'), "the figure exactly as printed");
    assert(snippet.includes("£m"), "the scale caption");
    assert(snippet.includes("period ended 2026-03-31"), "the period");
    assert(snippet.includes("Checked: double-read"), "the double-read tag");
    const p = fact(manifest, "cash").provenance!;
    assertEqual(p.kind, "scan-read", "provenance kind");
    assertEqual(p.page, 10, "provenance page");
    assertEqual(p.printedText, "1.7", "provenance printed text");
    assert(p.tags!.includes("double-read"), "provenance tag");
  });

  test("an unread line abstains with the model's own reason, not a silence", () => {
    const f = fact(manifest, "totalAssets");
    assertEqual(f.rung, "R4", "total assets abstains");
    assert(f.attemptLog![0].detail.includes("not-printed"), "the model's reason is kept");
  });

  suite("visionLive / scale, sign and the maturity split");

  test("the printed scale caption is applied, once", () => {
    assertEqual(fact(manifest, "turnover").value, 142_600_000, "142.6 under £m");
    assertEqual(fact(manifest, "cash").value, 1_700_000, "1.7 under £m");
  });

  test("a printed loss stays negative and a printed liability lands as a balance", () => {
    assertEqual(fact(manifest, "operatingProfit").value, -700_000, "operating loss (0.7) stays negative");
    assertEqual(fact(manifest, "netAssets").value, -4_900_000, "a net liabilities position is negative");
    assertEqual(fact(manifest, "netCurrentLiabilities").value, -8_300_000, "net current liabilities is negative");
    assertEqual(fact(manifest, "currentLiabilities").value, 19_900_000, "creditors in brackets is a positive balance");
    assertEqual(fact(manifest, "netInterest").value, 1_100_000, "interest expense is a positive cost");
  });

  test("a net liabilities line keeps the label the page printed", () => {
    assertEqual(fact(manifest, "netAssets").label, "Net liabilities", "printed label wins over 'Net assets'");
  });

  test("borrowings are added from the two printed maturity bands at R2, with the formula", () => {
    const b = fact(manifest, "borrowings");
    assertEqual(b.rung, "R2", "synthesised, never read as a total");
    assertEqual(b.value, 32_500_000, "2.5 + 30.0 under £m");
    assert(b.derivation!.formula.includes("within one year"), "the formula names both bands");
    assertEqual(b.derivation!.inputs.length, 2, "both printed lines are the inputs");
  });

  test("net debt and leverage follow from the split without any new reading", () => {
    assertEqual(fact(manifest, "netDebt").value, 30_800_000, "32.5 - 1.7 under £m");
    assertEqual(fact(manifest, "netDebt").rung, "R2", "synthesised");
  });

  suite("visionLive / the facilities table from the debt note (WP-BE16)");

  test("the live manifest carries the debt note's facilities, agreed by two reads and page-cited", async () => {
    assertEqual(provider.facilityReads, 1, "one facility read");
    const content = provider.lastFacilityRequest!.content;
    const doc = Array.isArray(content) ? content.find((c) => c.type === "document") : undefined;
    const sent = doc && doc.type === "document" ? new Uint8Array(Buffer.from(doc.source.data, "base64")) : new Uint8Array();
    assertEqual(await pdfPageCount(sent), 1, "only the debt-note page (21) was sent");
    const cs = manifest.capitalStructure!;
    assert(!!cs, "the manifest carries a capital structure");
    assertEqual(cs.status, "found", "the table is found");
    assertEqual(cs.fulcrumStated, false, "no fulcrum");
    const row = cs.rows[0];
    assertEqual(row.status, "found", "the term loan surfaces");
    assertEqual(row.page, 21, "cited to PDF page 21");
    assertEqual(row.cells.drawn.pounds, 30_000_000, "drawn £30.0m under the note's £m caption");
    assertEqual(row.cells.committed.pounds, 30_000_000, "committed £30.0m");
    assertEqual(row.cells.lender.text, "A lender", "lender as printed");
    assertEqual(row.cells.ranking.status, "not-printed", "no ranking stated, none shown");
    assert(row.citation.includes("PDF page 21"), "the citation names the page");
    assert(stages.some((e) => e.stage === "verify" && e.detail.startsWith("debt note:")), "the run reports the debt note");
  });

  test("a scripted run that injects its own verifier makes no facility read", () => {
    assertEqual(passThrough.capitalStructure, undefined, "no table without a reader");
  });

  test("a screen running cache-only makes no facility read either", () => {
    assertEqual(cacheOnlyProvider.facilityReads, 0, "no facility call");
    assertEqual(cacheHitProvider.facilityReads, 0, "no facility call on a cache hit");
    assertEqual(cacheHitManifest.capitalStructure?.status, "found", "the cached facility read is served");
  });

  suite("visionLive / filing selection and labels come from the resolver");

  test("the AA01 at the top of the accounts category is skipped for the AA below it", () => {
    // The stub serves the same document for every metadata URL, so the proof is the accounts
    // type: an AA01's description carries no accounts type and would label "unknown".
    assertEqual(manifest.entity.accountsType, "full", "the AA's own description, not the AA01's");
  });

  test("the accounts-type label is the resolver's, not the old filleted catch-all", () => {
    assert(manifest.entity.accountsType !== "filleted", "the register said filleted; the filing says full");
  });

  suite("visionLive / stage callbacks");

  test("every stage reports, in order, and each one ends", () => {
    const seen = stages.map((s) => `${s.stage}:${s.status}`);
    for (const stage of ["resolve", "fetch", "extract", "verify", "assemble"]) {
      assert(seen.some((s) => s.startsWith(`${stage}:`)), `${stage} reported`);
      assert(
        seen.some((s) => s === `${stage}:done` || s === `${stage}:skipped` || s === `${stage}:failed`),
        `${stage} finished`
      );
    }
    assertEqual(stages[0].stage, "resolve", "resolve is first");
    assertEqual(stages[stages.length - 1].stage, "assemble", "assemble is last");
    assert(stages.every((s) => !!Date.parse(s.at)), "every event carries an instant");
  });

  test("a callback that throws cannot fail the run", () => {
    assertEqual(fact(throwingCallbackManifest, "turnover").value, 142_600_000, "the sheet still built");
  });

  suite("visionLive / the verifier seam");

  test("with the pass-through verifier, not one scanned figure reaches the sheet", () => {
    for (const key of BASE_LINE_KEYS) {
      const f = passThrough.facts[`${keyMetric(key)}.${PK}`];
      assertEqual(f.value, null, `${key} does not surface on a single read`);
    }
    const detail = fact(passThrough, "turnover").attemptLog![0].detail;
    assert(detail.includes("Seen by one read only"), `the reason says so: ${detail}`);
    assertEqual(fact(passThrough, "borrowings")?.value ?? null, null, "nor does anything built from a single read");
  });

  test("the pass-through verifier checks nothing and says so on every line", async () => {
    const result = await passThroughVerifier.verify({ read: null as never, pdfBytes: SCAN_PDF, pageCount: 28 });
    assertEqual(Object.keys(result.lines).length, BASE_LINE_KEYS.length, "a tag for every base line");
    assert(
      BASE_LINE_KEYS.every((k) => result.lines[k].tag === "unverified"),
      "nothing is claimed as verified"
    );
    assertEqual(Object.keys(result.overrides).length, 0, "nothing is overridden");
    assertEqual(result.usage, null, "no model call, so no usage");
  });

  test("a rejected line abstains and is never rewritten", () => {
    const f = fact(rejected, "cash");
    assertEqual(f.value, null, "the rejected figure is gone, not corrected");
    assertEqual(f.rung, "R4", "it abstains");
    assert(f.attemptLog![0].detail.includes("verifier-disagreed"), "the verifier's reason is kept");
    assertEqual(fact(rejected, "turnover").value, 142_600_000, "the lines it agreed with are untouched");
  });

  test("a verifier cannot supply a line the reader abstained on", () => {
    const verification: VisionVerifyResult = {
      verifier: "test",
      lines: Object.fromEntries(BASE_LINE_KEYS.map((k) => [k, { tag: "verified" as const, note: null }])) as VisionVerifyResult["lines"],
      overrides: { total_assets: { status: "abstain", reason: "made-up" } },
      usage: null,
    };
    const read = { lines: Object.fromEntries(BASE_LINE_KEYS.map((k) => [k, { status: "abstain", reason: "not-printed" }])) } as never;
    const applied = applyVerification(read, verification);
    assertEqual(applied.read.lines.total_assets.status, "abstain", "still an abstention");
    assertEqual(applied.tags.total_assets.tag, "verified", "the override on an abstention is ignored");
  });

  suite("visionLive / nothing is bought by accident");

  test("cache-only with nothing cached makes no model call and abstains with its reason", () => {
    assertEqual(cacheOnlyProvider.calls, 0, "no model call on a screen");
    const f = fact(cacheOnlyManifest, "turnover");
    assertEqual(f.value, null, "no figure");
    assert(f.attemptLog![0].detail.includes("cache-only-no-model-call"), "it says why");
  });

  test("cache-only serves a read the cache already holds, still with no model call", () => {
    assertEqual(cacheHitProvider.calls, 0, "no model call");
    assertEqual(fact(cacheHitManifest, "turnover").value, 142_600_000, "the cached figures come back");
  });

  test("a filing over the page limit is never sent whole: with no page finder, no model call and it abstains", () => {
    assertEqual(tooLargeProvider.calls, 0, "no model call on an oversized filing");
    const f = fact(tooLarge, "turnover");
    assertEqual(f.value, null, "no figure");
    assert(
      f.attemptLog![0].detail.includes("page-finding-"),
      `the reason names page finding: ${f.attemptLog![0].detail}`
    );
  });

  suite("visionLive / scale captions");

  test("the captions Companies House filings print are understood", () => {
    assertEqual(scaleFromCaption("£'000"), 1_000, "£'000");
    assertEqual(scaleFromCaption("£000"), 1_000, "£000");
    assertEqual(scaleFromCaption("in thousands"), 1_000, "in thousands");
    assertEqual(scaleFromCaption("£m"), 1_000_000, "£m");
    assertEqual(scaleFromCaption("£'m"), 1_000_000, "£'m");
    assertEqual(scaleFromCaption("all figures in £ million"), 1_000_000, "£ million");
    assertEqual(scaleFromCaption("£"), 1, "whole pounds");
  });

  test("a caption this code does not understand abstains rather than guessing", () => {
    assertEqual(scaleFromCaption("per share"), null, "unknown caption");
    assertEqual(scaleFromCaption(""), null, "no caption");
    assertEqual(scaleFromCaption(null), null, "null caption");
  });

  suite("visionLive / the mapper stays pure");

  test("mapLiveToManifest with no accounts at all still abstains honestly", () => {
    const m = mapLiveToManifest(PROFILE, NO_CHARGES);
    assertEqual(m.facts[`turnover.${PK}`].rung, "R4", "turnover abstains");
    assertEqual(m.entity.accountsType, "filleted", "with no filing, the profile's own label is used");
  });
}

// The engine metric name for a base line key, so the "every line answers" test can look each
// one up. Mirrors VISION_METRICS in lib/sources/visionAccounts.ts.
function keyMetric(key: BaseLineKey): string {
  const map: Record<BaseLineKey, string> = {
    turnover: "turnover",
    operating_profit: "operatingProfit",
    depreciation_amortisation: "depreciationAmortisation",
    interest_payable: "netInterest",
    profit_before_tax: "profitBeforeTax",
    cash_at_bank: "cash",
    borrowings_within_one_year: "borrowingsWithinOneYear",
    borrowings_after_one_year: "borrowingsAfterOneYear",
    lease_liabilities_total: "leaseLiabilitiesTotal",
    lease_liabilities_current: "leaseLiabilitiesCurrent",
    lease_liabilities_non_current: "leaseLiabilitiesNonCurrent",
    preference_shares: "preferenceShares",
    shareholder_loans: "shareholderLoans",
    net_assets: "netAssets",
    total_assets: "totalAssets",
    current_liabilities: "currentLiabilities",
    net_current_liabilities: "netCurrentLiabilities",
  };
  return map[key];
}
