// test/modelLive.test.ts
// The live Excel model (WP-BE07). Every case opens the xlsx the route actually serves: the bytes
// from lib/model/serve.ts are loaded back with exceljs, and the sheets, formulas, number formats,
// fonts, colours and source columns are read off the file, not off the in-memory workbook.
//
// No network and no model call. Three recorded sources:
//   - Companies House: a real run through the WP-BE06 runner for Boparan Holdings (03558065),
//     on the frozen 113-page scan, with its first read, second read and debt-note facility read
//     all replayed from recordings (test/fixtures/vision). Global fetch is mocked for the register.
//   - ESEF: the trimmed Tesco UKSEF filing (test/fixtures/tesco_esef.json).
//   - SEC: Apple's recorded company facts (eval/gold/fixtures/AAPL.json), the /sheet/sec-aapl case.
//
// Everything is fetched during registration, before any test body runs, so a later suite that
// resets the shared stores cannot empty them under these assertions.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import ExcelJS from "exceljs";
// exceljs's own zip library (a dependency of exceljs), used only to read raw parts of the file.
import JSZip from "jszip";
import { suite, test, assert, assertEqual } from "./harness";
import { InMemoryCache } from "../lib/cache/cache";
import { AnthropicProvider } from "../lib/llm/providers/anthropic";
import { InMemoryRunStore } from "../lib/run/store";
import { runToCompletion } from "../lib/run/runner";
import type { RunRecord } from "../lib/run/types";
import type { ChFilingItem, ChProfile, ChSearchResult, ResolveClient } from "../lib/resolve/types";
import { getTearSheet, saveManifest, sourceKey } from "../lib/workspace";
import { mapEsefToManifest, type EsefDoc } from "../lib/sources/esef";
import { mapEdgarToManifest, type CompanyFacts, type Submissions } from "../lib/sources/secEdgar";
import type { TearSheet } from "../lib/engine/assemble";
import { serveModel, XLSX_TYPE } from "../lib/model/serve";
import { FACILITY_TABLE_HEADER, INPUT_COLS, INPUT_ROW, MODEL_ROW, SOURCES_HEADER } from "../lib/model/buildWorkbook";
import { MODEL_BRAND_COLOUR, MODEL_TOKENS } from "../lib/model/tokens";
import { stageOf } from "./pageFindingCases";
import { loadReads, finderModelOf } from "../eval/gold/uk-reads";
const BOPARAN_FOLDER = "03558065-2025-07-26";

const HERE = dirname(fileURLToPath(import.meta.url));
const VISION_FX = join(HERE, "fixtures", "vision");
const loadJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

const TENANT = "model-desk-a";
const OTHER_TENANT = "model-desk-b";

// --- Two companies on the register (fetch mock and resolver) -----------------
// Bristol Water files full (company) accounts, so its recorded reads land figures: it is the
// case for the Inputs, the Model and the page references. Boparan files group accounts; its
// second read here cannot tell the group's statements from the company's, so every scan figure
// abstains on basis (the engine's rule since WP-GRPCHK and WP-BE19), but its debt note was read
// twice and agreed: it is the case for the Facilities sheet.
//
// Since WP-BE14-LIVE-2 Boparan's reads are the gold re-recordings. They were page-found, so the run
// replays the recorded page-finding too. The re-recorded second read (v4) states the basis of every
// line, where the WP-BE05 answer stated none; the case keeps the no-basis second read by writing
// "none" and no basis words into each line of the recording, which is how the engine reads a v1
// answer (lib/vision/secondRead.ts).

interface ChCase {
  number: string;
  profile: ChProfile;
  filing: ChFilingItem;
  pdf: Uint8Array;
  charges: unknown;
  // Recordings by stage. A stage with no recording answers an error, which the engine abstains on.
  recordings: [string, unknown][];
  // Recorded with page-finding (contents and classify stages among the recordings) by this finder model.
  finderModel?: string;
}

const DOC_API = "https://document-api.company-information.service.gov.uk/document";
const GOLD = join(HERE, "..", "eval", "gold", "fixtures", "uk");
const NO_CHARGES = { total_count: 0, unfiled_count: 0, items: [] };

function chCase(o: {
  number: string;
  name: string;
  type: string;
  created: string;
  locality: string;
  madeUpTo: string;
  accountsType: "group" | "full";
  filedOn: string;
  transactionId: string;
  pages: number;
  folder: string;
  charges: unknown;
  recordings: [string, unknown][];
  finderModel?: string;
}): ChCase {
  return {
    number: o.number,
    profile: {
      company_name: o.name,
      company_number: o.number,
      company_status: "active",
      type: o.type,
      jurisdiction: "england-wales",
      date_of_creation: o.created,
      registered_office_address: { address_line_1: "Registered office", locality: o.locality, country: "England" },
      accounts: { last_accounts: { made_up_to: o.madeUpTo, type: o.accountsType }, next_due: "2026-12-31" },
    },
    filing: {
      transaction_id: o.transactionId,
      category: "accounts",
      type: "AA",
      description: `accounts-with-accounts-type-${o.accountsType}`,
      description_values: { made_up_date: o.madeUpTo },
      date: o.filedOn,
      pages: o.pages,
      links: { document_metadata: `${DOC_API}/${o.number}-FROZEN` },
    },
    pdf: new Uint8Array(readFileSync(join(GOLD, o.folder, "filing.pdf"))),
    charges: o.charges,
    recordings: o.recordings,
    finderModel: o.finderModel,
  };
}

const BRISTOL = chCase({
  number: "02662226",
  name: "BRISTOL WATER PLC",
  type: "plc",
  created: "1991-10-18",
  locality: "Bristol",
  madeUpTo: "2026-03-31",
  accountsType: "full",
  filedOn: "2026-09-11",
  transactionId: "MzU0MjkxMjg1OGFkaXF6a2N4",
  pages: 28,
  folder: "02662226-2026-03-31",
  charges: NO_CHARGES,
  recordings: [
    ["first-read", loadJson(join(VISION_FX, "bristol-water-02662226.json")).response],
    ["second-read", loadJson(join(VISION_FX, "verify", "02662226-second.json")).response],
  ],
});

// A recorded second read with every line's basis unstated, as a v1 answer is read.
function withNoBasis(response: any): any {
  const copy = JSON.parse(JSON.stringify(response));
  const block = [...copy.content].reverse().find((b: any) => b.type === "text");
  const answer = JSON.parse(block.text);
  for (const l of answer.lines) Object.assign(l, { basis: "none", basis_text: "" });
  block.text = JSON.stringify(answer);
  return copy;
}

const BOPARAN = chCase({
  number: "03558065",
  name: "BOPARAN HOLDINGS LIMITED",
  type: "ltd",
  created: "1998-04-30",
  locality: "Birmingham",
  madeUpTo: "2025-07-26",
  accountsType: "group",
  filedOn: "2026-05-04",
  transactionId: "MzUxODk5OTExM2FkaXF6a2N4",
  pages: 113,
  folder: "03558065-2025-07-26",
  charges: {
    total_count: 1,
    unfiled_count: 0,
    items: [
      {
        charge_number: 1,
        status: "outstanding",
        created_on: "2024-11-07",
        classification: { type: "charge-description", description: "A registered charge" },
        persons_entitled: [{ name: "Security Trustee Limited" }],
        secured_details: { description: "Fixed and floating charge" },
      },
    ],
  },
  finderModel: finderModelOf(loadReads(BOPARAN_FOLDER)!),
  recordings: [
    ...loadReads(BOPARAN_FOLDER)!
      .calls.filter((c) => c.stage === "contents" || c.stage.startsWith("classify:"))
      .map((c): [string, unknown] => [c.stage, c.response]),
    ["first-read", loadJson(join(VISION_FX, "verify", "03558065-first.json")).response],
    ["second-read", withNoBasis(loadJson(join(VISION_FX, "verify", "03558065-second.json")).response)],
    ["facility-read", loadJson(join(VISION_FX, "facilities", "03558065.json")).calls.find((c: { stage: string }) => c.stage === "facility-read").response],
  ],
});

const CH_CASES = [BRISTOL, BOPARAN];

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

function installFetchMock(): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("gleif")) return jsonResponse({ data: [] });
    const c = CH_CASES.find((x) => url.includes(x.number));
    if (!c) return jsonResponse({}, 404);
    const meta = c.filing.links!.document_metadata!;
    if (url === `${meta}/content`) return pdfResponse(c.pdf);
    if (url.startsWith(meta)) {
      return jsonResponse({ links: { document: `${meta}/content` }, resources: { "application/pdf": { content_type: "application/pdf" } } });
    }
    if (url.includes("/filing-history")) return jsonResponse({ total_count: 1, items: [c.filing] });
    if (url.includes("/charges")) return jsonResponse(c.charges);
    if (url.includes("/insolvency")) return jsonResponse({ errors: [] }, 404);
    if (url.includes("/company/")) return jsonResponse(c.profile);
    return jsonResponse({}, 404);
  }) as typeof fetch;
}

class CaseResolveClient implements ResolveClient {
  constructor(private readonly c: ChCase) {}
  async search(): Promise<ChSearchResult> {
    const p = this.c.profile;
    const items = [{ company_number: p.company_number, title: p.company_name, company_status: "active", company_type: p.type, date_of_creation: p.date_of_creation, address: { locality: "England" } }];
    return { items, total_results: 1 } as ChSearchResult;
  }
  async profile(number: string): Promise<ChProfile | null> {
    return number === this.c.number ? this.c.profile : null;
  }
  async filingHistory(number: string): Promise<ChFilingItem[]> {
    return number === this.c.number ? [this.c.filing] : [];
  }
  async leiForCompanyNumber(): Promise<string | null> {
    return null;
  }
}

// Every model call answered from its recording, by stage. An unrecorded stage answers a 400, so
// a run that tried anything unrecorded abstains there and nothing reaches the network.
function recordedProvider(c: ChCase, model = "claude-opus-5", stages: string[] = []): { provider: AnthropicProvider; stages: string[] } {
  const byStage = new Map<string, unknown>(c.recordings);
  const provider = new AnthropicProvider(
    { provider: "anthropic", model, apiKey: "replay", maxTokens: 1024 },
    {
      fetchImpl: async (_u: unknown, init?: RequestInit) => {
        const stage = stageOf(JSON.parse(String(init?.body)));
        stages.push(stage);
        const response = byStage.get(stage);
        if (!response) return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: `no recording for ${stage}` } }), { status: 400, headers: { "content-type": "application/json" } });
        return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
      },
      logUsage: () => {},
      sleep: async () => {},
    } as never
  );
  return { provider, stages };
}

async function runCase(c: ChCase, store: InMemoryRunStore): Promise<{ run: RunRecord; stages: string[] }> {
  const { provider, stages } = recordedProvider(c);
  // The page finder is the cheap model the recording was made with; its stages are logged with the reader's.
  const pageFinder = c.finderModel ? recordedProvider(c, c.finderModel, stages).provider : null;
  const run = await runToCompletion(TENANT, c.number, {
    store,
    resolveClient: new CaseResolveClient(c),
    // A page-found recording replays through page-finding, answered by stage from the same
    // recordings; a whole-document recording replays on the whole document.
    buildOptions: { visionDeps: pageFinder ? { provider, pageFinder, cache: new InMemoryCache() } : { provider, cache: new InMemoryCache(), pageFindingAbovePages: 200 } },
  });
  return { run, stages };
}

// --- Reading an xlsx back -------------------------------------------------------

interface Served {
  status: number;
  headers: Headers;
  body: Uint8Array;
  wb: ExcelJS.Workbook | null;
  // The raw parts exceljs does not read back: the calculation properties and the style table.
  workbookXml: string;
  stylesXml: string;
  json: Record<string, unknown> | null;
}

async function fetchModel(tenantId: string, id: string, runStore?: InMemoryRunStore): Promise<Served> {
  const res = await serveModel(tenantId, id, { runStore });
  const body = new Uint8Array(await res.arrayBuffer());
  let wb: ExcelJS.Workbook | null = null;
  let json: Record<string, unknown> | null = null;
  let workbookXml = "";
  let stylesXml = "";
  if (res.headers.get("content-type") === XLSX_TYPE) {
    wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(body) as unknown as ArrayBuffer);
    const zip = await JSZip.loadAsync(body);
    workbookXml = (await zip.file("xl/workbook.xml")?.async("string")) ?? "";
    stylesXml = (await zip.file("xl/styles.xml")?.async("string")) ?? "";
  } else {
    json = JSON.parse(new TextDecoder().decode(body));
  }
  return { status: res.status, headers: res.headers, body, wb, workbookXml, stylesXml, json };
}

function sheet(wb: ExcelJS.Workbook | null, name: string): ExcelJS.Worksheet {
  const ws = wb?.getWorksheet(name);
  if (!ws) throw new Error(`worksheet ${name} missing`);
  return ws;
}

function formulaOf(v: ExcelJS.CellValue): string | null {
  if (v && typeof v === "object" && "formula" in v) return String((v as ExcelJS.CellFormulaValue).formula);
  return null;
}

function resultOf(v: ExcelJS.CellValue): unknown {
  return v && typeof v === "object" && "formula" in v ? (v as ExcelJS.CellFormulaValue).result : undefined;
}

// A small evaluator for the formulas this workbook writes (+ - * /, comparisons, IF, ABS and
// cell references), so a test can change an input and watch the model recompute, the way Excel
// does on open. `overrides` stands in for a typed-over input cell.
function evaluate(wb: ExcelJS.Workbook, sheetName: string, addr: string, overrides: Map<string, number> = new Map()): unknown {
  const key = `${sheetName}!${addr}`;
  if (overrides.has(key)) return overrides.get(key);
  const v = sheet(wb, sheetName).getCell(addr).value;
  const f = formulaOf(v);
  if (f === null) return v === null || v === undefined ? 0 : v;
  const js = f
    .replace(/(?:([A-Za-z]+)!)?\$?([A-Z]{1,2})\$?(\d+)/g, (_m, s, col, row) => `ref(${JSON.stringify(s ?? sheetName)},"${col}${row}")`)
    .replace(/<>/g, "!==")
    .replace(/(?<![<>!=])=(?!=)/g, "===");
  const ref = (s: string, a: string) => evaluate(wb, s, a, overrides);
  const IF = (c: unknown, a: unknown, b: unknown) => (c ? a : b);
  const ABS = (x: number) => Math.abs(x);
  return new Function("ref", "IF", "ABS", `return (${js});`)(ref, IF, ABS);
}

// Every written cell of every sheet, as [sheet, address, cell].
function everyCell(wb: ExcelJS.Workbook): [string, string, ExcelJS.Cell][] {
  const out: [string, string, ExcelJS.Cell][] = [];
  for (const ws of wb.worksheets) {
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        if (cell.isMerged && cell.master !== cell) return;
        out.push([ws.name, cell.address, cell]);
      });
    });
  }
  return out;
}

const SHEETS = ["Cover", "Inputs", "Model", "Capital structure", "Facilities", "Sources", "Provenance"];
const TOKEN_COLOURS = new Set<string>(Object.values(MODEL_TOKENS.colour));

// --- The shared checks, run on every served workbook ------------------------------

function registerCommonChecks(label: string, get: () => { served: Served; ts: TearSheet }): void {
  test(`${label}: the download is an xlsx with the seven model sheets`, () => {
    const { served } = get();
    assertEqual(served.status, 200, "200");
    assertEqual(served.headers.get("content-type"), XLSX_TYPE, "xlsx content type");
    assert(/^attachment; filename="[a-z0-9-]+-model\.xlsx"$/.test(served.headers.get("content-disposition") ?? ""), "attachment with a slug filename");
    assertEqual(served.headers.get("cache-control"), "private, no-store", "never cached by a shared cache");
    assertEqual(served.wb!.worksheets.map((w) => w.name).join("|"), SHEETS.join("|"), "sheet order");
  });

  test(`${label}: every Input figure is the sheet's own figure, with document, page and line beside it`, () => {
    const { served, ts } = get();
    const inputs = sheet(served.wb, "Inputs");
    const latest = ts.financials.latestLabel;
    let figures = 0;
    for (const [metric, row] of Object.entries(INPUT_ROW)) {
      const v = inputs.getCell(row, INPUT_COLS.latest).value;
      const exported = ts.exportRows.find((r) => r.metric === metric && r.period === latest);
      if (typeof v !== "number") {
        assert(v === null || v === undefined, `${metric}: blank when not a number (got ${JSON.stringify(v)})`);
        assert(!exported || exported.value === "" || !Number.isFinite(Number(exported.value)), `${metric}: blank only when the sheet has no figure`);
        continue;
      }
      figures++;
      assertEqual(v, Number(exported!.value), `${metric}: the workbook figure is the sheet's`);
      // The sheet's financials table shows the same fact in the latest column.
      const tableRow = ts.financials.rows.find((r) => r.metric === metric);
      if (tableRow) {
        const cell = tableRow.cells[ts.financials.periodLabels.indexOf(latest)];
        assertEqual(cell?.factId, `${metric}.${latest}`, `${metric}: the sheet's table cell is the same fact`);
      }
      assertEqual(inputs.getCell(row, INPUT_COLS.latest).numFmt, "#,##0;(#,##0)", `${metric}: money format`);
      const doc = inputs.getCell(row, INPUT_COLS.document).value;
      assert(typeof doc === "string" && doc.length > 0, `${metric}: a document is named`);
      const page = inputs.getCell(row, INPUT_COLS.page).value;
      assert(typeof page === "number" || page === "not stated", `${metric}: a page, or "not stated" (got ${JSON.stringify(page)})`);
      const line = inputs.getCell(row, INPUT_COLS.line).value;
      assert(typeof line === "string" && line.length > 0, `${metric}: the line as printed`);
    }
    assert(figures >= 2, `at least two reported base lines land (got ${figures})`);
  });

  test(`${label}: the Model is live formulas over the Inputs, each with its computed result`, () => {
    const { served } = get();
    const model = sheet(served.wb, "Model");
    let formulas = 0;
    for (const row of Object.values(MODEL_ROW)) {
      for (const col of ["B", "C", "D"]) {
        const v = model.getCell(`${col}${row}`).value;
        const f = formulaOf(v);
        if (f === null) {
          assert(v === null || v === undefined, `Model!${col}${row} is a formula or blank, never a pasted number (got ${JSON.stringify(v)})`);
          continue;
        }
        formulas++;
        const computed = evaluate(served.wb!, "Model", `${col}${row}`);
        const cached = resultOf(v);
        if (typeof computed === "number") assert(Math.abs(computed - Number(cached)) < 1e-9 * Math.max(1, Math.abs(computed)), `Model!${col}${row}: cached ${cached} is what the formula computes (${computed})`);
        else assertEqual(cached, computed, `Model!${col}${row}: cached result`);
      }
    }
    assert(formulas >= 1, "at least one derived metric is a formula");
    assert(/<calcPr[^>]*fullCalcOnLoad="1"/.test(served.workbookXml), "Excel and LibreOffice recalculate on open");
    const lev = model.getCell(`B${MODEL_ROW.leverage}`);
    if (formulaOf(lev.value)) assertEqual(lev.numFmt, '0.00"x"', "leverage is a multiple");
  });

  test(`${label}: changing an Input recomputes the Model`, () => {
    const { served } = get();
    const model = sheet(served.wb, "Model");
    const nd = `B${MODEL_ROW.netDebt}`;
    const ebitda = `B${MODEL_ROW.ebitda}`;
    const target = formulaOf(model.getCell(nd).value) ? { cell: nd, input: `Inputs!B${INPUT_ROW.cash}`, sign: -1 } : formulaOf(model.getCell(ebitda).value) ? { cell: ebitda, input: `Inputs!B${INPUT_ROW.operatingProfit}`, sign: 1 } : null;
    assert(target !== null, "net debt or EBITDA is a formula");
    const before = evaluate(served.wb!, "Model", target!.cell) as number;
    const [s, a] = target!.input.split("!");
    const was = sheet(served.wb, s).getCell(a).value as number;
    const after = evaluate(served.wb!, "Model", target!.cell, new Map([[target!.input, was + 1_000_000]])) as number;
    assertEqual(after - before, target!.sign * 1_000_000, `${target!.cell} moves with ${target!.input}`);
  });

  test(`${label}: every figure on the Sources sheet names its document`, () => {
    const { served, ts } = get();
    const src = sheet(served.wb, "Sources");
    assertEqual(SOURCES_HEADER.map((_, i) => src.getCell(1, i + 1).value).join("|"), SOURCES_HEADER.join("|"), "header");
    const held = ts.exportRows.filter((r) => r.value !== "").length;
    assertEqual(src.actualRowCount - 1, held, "one row per figure the sheet holds a value for");
    for (let r = 2; r <= src.actualRowCount; r++) {
      assert(typeof src.getCell(r, 6).value === "string" && String(src.getCell(r, 6).value).length > 0, `Sources row ${r}: a document`);
      const page = src.getCell(r, 7).value;
      assert(typeof page === "number" || page === "not stated", `Sources row ${r}: a page or "not stated"`);
    }
  });

  test(`${label}: Georgia for words, Courier New for figures, token colours only, no Calibri`, () => {
    const { served } = get();
    const cells = everyCell(served.wb!);
    assert(cells.length > 20, "cells written");
    for (const [ws, addr, cell] of cells) {
      const name = cell.font?.name;
      assert(name === MODEL_TOKENS.font.text || name === MODEL_TOKENS.font.figure, `${ws}!${addr}: font ${name}`);
      const isFigure = typeof cell.value === "number" || formulaOf(cell.value) !== null;
      if (isFigure) assertEqual(name, MODEL_TOKENS.font.figure, `${ws}!${addr}: a figure is set in Courier New`);
      const colour = cell.font?.color?.argb;
      assert(colour === undefined || TOKEN_COLOURS.has(colour), `${ws}!${addr}: font colour ${colour} is a token`);
      const fill = cell.fill && cell.fill.type === "pattern" ? (cell.fill.fgColor?.argb ?? undefined) : undefined;
      assert(fill === undefined || TOKEN_COLOURS.has(fill), `${ws}!${addr}: fill ${fill} is a token`);
    }
    // The style table: exceljs always writes Calibri as font 0, the default of the unstyled
    // "Normal" format (cellXfs 0). No format a written cell uses may point at it.
    const fonts = [...served.stylesXml.matchAll(/<font>([\s\S]*?)<\/font>/g)].map((m) => m[1].match(/<name val="([^"]+)"/)?.[1]);
    fonts.slice(1).forEach((f, i) => assert(f === MODEL_TOKENS.font.text || f === MODEL_TOKENS.font.figure, `styles font ${i + 1} is ${f}`));
    const cellXfs = served.stylesXml.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? "";
    const xfFonts = [...cellXfs.matchAll(/<xf [^>]*fontId="(\d+)"/g)].map((m) => Number(m[1]));
    assert(xfFonts.length > 1, "cell formats written");
    xfFonts.slice(1).forEach((id, i) => assert(id !== 0, `cell format ${i + 1} does not use the Calibri default`));
  });
}

// --- Setup ----------------------------------------------------------------------

let runStore: InMemoryRunStore;
let chRun: RunRecord;
let chStages: string[] = [];
let chServed: Served;
let chByKey: Served;
let chTs: TearSheet;
let bopRun: RunRecord;
let bopStages: string[] = [];
let bopServed: Served;
let bopTs: TearSheet;
let chOtherTenantByRun: Served;
let chOtherTenantByKey: Served;
let chSignedOut: Served;
let pendingRun: Served;
let esefKey: string;
let esefServed: Served;
let esefTs: TearSheet;
let esefOtherTenant: Served;
let secKey: string;
let secServed: Served;
let secTs: TearSheet;
let fixtureServed: Served;
let unknownKey: Served;

export async function registerModelLiveTests(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.CH_API_KEY;
  installFetchMock();
  process.env.CH_API_KEY = "demo-key";
  try {
    // 1. Two live Companies House runs, through the runner, on recorded reads.
    runStore = new InMemoryRunStore();
    ({ run: chRun, stages: chStages } = await runCase(BRISTOL, runStore));
    ({ run: bopRun, stages: bopStages } = await runCase(BOPARAN, runStore));
    if (chRun.sheetKey) {
      chTs = (await getTearSheet(TENANT, chRun.sheetKey))!.ts;
      chServed = await fetchModel(TENANT, chRun.id, runStore);
      chByKey = await fetchModel(TENANT, chRun.sheetKey, runStore);
      chOtherTenantByKey = await fetchModel(OTHER_TENANT, chRun.sheetKey, runStore);
    }
    if (bopRun.sheetKey) {
      bopTs = (await getTearSheet(TENANT, bopRun.sheetKey))!.ts;
      bopServed = await fetchModel(TENANT, bopRun.id, runStore);
    }
    chOtherTenantByRun = await fetchModel(OTHER_TENANT, chRun.id, runStore);
    chSignedOut = await fetchModel("", chRun.id, runStore);

    // A run that has not produced a sheet.
    await runStore.save({ ...chRun, id: "run-still-going", status: "running", sheetKey: null, endedAt: null, reason: null });
    pendingRun = await fetchModel(TENANT, "run-still-going", runStore);

    // 2. An ESEF sheet (Tesco), saved to the workspace as the ESEF route saves it.
    const tesco = JSON.parse(readFileSync(join(HERE, "fixtures", "tesco_esef.json"), "utf8")) as EsefDoc;
    const esef = mapEsefToManifest("2138002P5RNKC5W2JZ46", "TESCO PLC", "fxo-test", tesco)!;
    esefKey = sourceKey("esef", esef);
    await saveManifest(TENANT, esefKey, esef);
    esefTs = (await getTearSheet(TENANT, esefKey))!.ts;
    esefServed = await fetchModel(TENANT, esefKey, runStore);
    esefOtherTenant = await fetchModel(OTHER_TENANT, esefKey, runStore);

    // 3. A saved SEC sheet (Apple), the audit's /sheet/sec-aapl case.
    const cf = loadJson(join(HERE, "..", "eval", "gold", "fixtures", "AAPL.json")) as CompanyFacts;
    const sec = mapEdgarToManifest({ cik: "320193", name: "Apple Inc." } as Submissions, cf);
    secKey = sourceKey("sec", sec);
    await saveManifest(TENANT, secKey, sec);
    secTs = (await getTearSheet(TENANT, secKey))!.ts;
    secServed = await fetchModel(TENANT, secKey, runStore);

    // 4. The bundled demo fixture still downloads, and an unknown key is a 404.
    fixtureServed = await fetchModel(OTHER_TENANT, "meridian", runStore);
    unknownKey = await fetchModel(TENANT, "ch-99999999", runStore);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.CH_API_KEY;
    else process.env.CH_API_KEY = originalKey;
  }

  suite("model live / a Companies House run (Bristol Water, recorded reads)");

  test("the run finishes on recorded reads alone and names its sheet", () => {
    assertEqual(chRun.status, "done", `run status (reason: ${chRun.reason})`);
    assertEqual(chRun.sheetKey, `ch-${BRISTOL.number}`, "sheet key");
    assert(chStages.includes("first-read") && chStages.includes("second-read"), `recorded stages answered (${chStages.join(", ")})`);
  });

  test("the model downloads by run id and by sheet key, the same workbook", () => {
    assertEqual(chServed.status, 200, "by run id");
    assertEqual(chByKey.status, 200, "by sheet key");
    const cover = sheet(chServed.wb, "Cover");
    const byRow = (k: string) => {
      for (let r = 1; r <= cover.actualRowCount; r++) if (cover.getCell(r, 1).value === k) return cover.getCell(r, 2).value;
      return undefined;
    };
    assertEqual(byRow("Run id"), chRun.id, "the Cover names the run");
    assertEqual(byRow("Sheet key"), `ch-${BRISTOL.number}`, "and the sheet key");
    assertEqual(byRow("Mode"), "Live, Companies House public record", "live CH mode");
    assertEqual(sheet(chByKey.wb, "Cover").getCell("A1").value, "BRISTOL WATER PLC", "same company by key");
  });

  registerCommonChecks("CH", () => ({ served: chServed, ts: chTs }));

  test("CH: a scan-read figure carries its PDF page as a number", () => {
    const inputs = sheet(chServed.wb, "Inputs");
    const pages = Object.values(INPUT_ROW)
      .filter((row) => typeof inputs.getCell(row, INPUT_COLS.latest).value === "number")
      .map((row) => inputs.getCell(row, INPUT_COLS.page).value);
    assert(pages.length > 0 && pages.every((p) => typeof p === "number" && p >= 1), `every scan figure has a page (${JSON.stringify(pages)})`);
  });

  suite("model live / a Companies House group run with a debt note (Boparan, recorded reads)");

  test("the run finishes, and its scan figures abstain on basis rather than landing", () => {
    assertEqual(bopRun.status, "done", `run status (reason: ${bopRun.reason})`);
    assert(bopStages.includes("facility-read"), `the debt note was read (${bopStages.join(", ")})`);
    const inputs = sheet(bopServed.wb, "Inputs");
    for (const [metric, row] of Object.entries(INPUT_ROW)) {
      const v = inputs.getCell(row, INPUT_COLS.latest).value;
      assert(v === null || v === undefined, `${metric}: blank, never invented, when the sheet abstains`);
      assertEqual(inputs.getCell(row, INPUT_COLS.document).value, "not reported", `${metric}: says it is not reported`);
    }
    const model = sheet(bopServed.wb, "Model");
    for (const row of Object.values(MODEL_ROW)) assert(model.getCell(`B${row}`).value == null, `Model row ${row} is blank`);
  });

  test("Boparan: the Facilities sheet lists the debt-note rows with their page references", () => {
    const fac = sheet(bopServed.wb, "Facilities");
    let headRow = 0;
    for (let r = 1; r <= fac.actualRowCount + 5; r++) if (fac.getCell(r, 1).value === "Facility") headRow = r;
    assert(headRow > 0, "the facilities table header");
    assertEqual(
      FACILITY_TABLE_HEADER.map((_, i) => fac.getCell(headRow, i + 1).value).join("|"),
      FACILITY_TABLE_HEADER.join("|"),
      "header columns"
    );
    const table = bopTs.facilities!;
    assertEqual(table.status, "found", "the run's table was found");
    const pageCol = FACILITY_TABLE_HEADER.indexOf("Page") + 1;
    const committedCol = FACILITY_TABLE_HEADER.indexOf("Committed") + 1;
    const drawnCol = FACILITY_TABLE_HEADER.indexOf("Drawn") + 1;
    table.rows.forEach((row, i) => {
      const r = headRow + 1 + i;
      assertEqual(fac.getCell(r, 1).value, row.name ?? "name not printed", `row ${i + 1}: the note's own name`);
      assertEqual(fac.getCell(r, pageCol).value, row.page, `row ${i + 1}: page reference`);
      assertEqual(fac.getCell(r, pageCol).numFmt, "0", `row ${i + 1}: page is a plain integer`);
      assertEqual(fac.getCell(r, pageCol).font?.name, MODEL_TOKENS.font.figure, `row ${i + 1}: page in the figure font`);
      const committed = row.cells.committed;
      if (committed.status === "agreed" && committed.pounds !== null && !committed.nil) {
        assertEqual(fac.getCell(r, committedCol).value, committed.pounds, `row ${i + 1}: committed in pounds`);
        assertEqual(fac.getCell(r, committedCol).numFmt, "#,##0;(#,##0)", `row ${i + 1}: money format`);
      }
      const drawn = row.cells.drawn;
      if (drawn.status === "agreed" && (drawn.nil || drawn.pounds === null)) {
        assertEqual(fac.getCell(r, drawnCol).value, drawn.text, `row ${i + 1}: an amount printed as words stays words, never 0`);
      }
    });
    // The re-recorded first read lists four lines of note 21; the bond and the RCF were listed by
    // both reads, the bond at amortised cost and the other borrowings total by the first only.
    assertEqual(table.rows.length, 4, "four rows from Boparan's note");
    assertEqual(table.rows.filter((row) => row.status === "found").length, 2, "two facilities seen by both reads");
    assert(table.rows.every((row) => row.page === 91), "all on PDF page 91");
    const committed = table.rows.flatMap((row, i) => (row.status === "found" ? [fac.getCell(headRow + 1 + i, committedCol).value] : []));
    assertEqual(committed.join(","), "390000000,80000000", "the bond and the RCF, committed");
  });

  test("Boparan: no row claims a fulcrum or a seniority", () => {
    const fac = sheet(bopServed.wb, "Facilities");
    let said = false;
    for (let r = 1; r <= 10; r++) if (/No fulcrum and no seniority order is stated/.test(String(fac.getCell(r, 2).value ?? ""))) said = true;
    assert(said, "the Facilities sheet says no fulcrum is stated");
    assert(bopTs.capital.every((c) => !c.isFulcrum), "and the capital rows carry none");
    const cap = sheet(bopServed.wb, "Capital structure");
    assertEqual(cap.getCell(2, 2).value, "ranking not stated", "the registered charge states no rank");
  });

  suite("model live / tenancy and sign-in");

  test("another tenant gets 404 for the run id and for the sheet key", () => {
    assertEqual(chOtherTenantByRun.status, 404, "by run id");
    assertEqual(chOtherTenantByKey.status, 404, "by sheet key");
    assertEqual(esefOtherTenant.status, 404, "an ESEF sheet too");
    assertEqual(chOtherTenantByKey.json?.error, "No such sheet.", "the same answer as a key that does not exist");
    assertEqual(unknownKey.json?.error, "No such sheet.", "a key that does not exist");
  });

  test("a signed-out request gets 401 with the body WP-FE01's middleware sends", () => {
    assertEqual(chSignedOut.status, 401, "401");
    assertEqual(JSON.stringify(chSignedOut.json), JSON.stringify({ error: "Sign in required." }), "same body as the gate");
  });

  test("a run with no sheet yet is a 409 that says so, not a 404 or an empty file", () => {
    assertEqual(pendingRun.status, 409, "409");
    assertEqual(pendingRun.json?.status, "running", "names the run's status");
  });

  suite("model live / an ESEF sheet (Tesco)");

  registerCommonChecks("ESEF", () => ({ served: esefServed, ts: esefTs }));

  test("ESEF: the figures are Tesco's filed figures, and the Cover says ESEF", () => {
    const inputs = sheet(esefServed.wb, "Inputs");
    assertEqual(inputs.getCell(INPUT_ROW.turnover, INPUT_COLS.latest).value, 73_712_000_000, "revenue GBP 73,712m");
    assertEqual(inputs.getCell(INPUT_ROW.operatingProfit, INPUT_COLS.latest).value, 2_985_000_000, "statutory operating profit");
    assertEqual(inputs.getCell(INPUT_ROW.cash, INPUT_COLS.latest).value, 2_515_000_000, "cash");
    const cover = sheet(esefServed.wb, "Cover");
    let mode = "";
    for (let r = 1; r <= cover.actualRowCount; r++) if (cover.getCell(r, 1).value === "Mode") mode = String(cover.getCell(r, 2).value);
    assert(mode.includes("ESEF"), `mode names ESEF (${mode})`);
    const nd = sheet(esefServed.wb, "Model").getCell(`B${MODEL_ROW.netDebt}`);
    assertEqual(resultOf(nd.value), 5_372_000_000 + 1_824_000_000 - 2_515_000_000, "net debt computes to the sheet's net debt");
    assertEqual(evaluate(esefServed.wb!, "Model", `B${MODEL_ROW.netDebt}`), Number(esefTs.exportRows.find((r) => r.metric === "netDebt")?.value), "and equals the ladder's own net debt fact");
  });

  test("ESEF: with no debt note read, the Facilities sheet says so rather than showing an empty table", () => {
    assertEqual(esefTs.facilities, null, "no facilities on an ESEF sheet");
    assert(/No scanned debt note was read/.test(String(sheet(esefServed.wb, "Facilities").getCell(2, 1).value)), "says why");
  });

  suite("model live / a saved SEC sheet (the /sheet/sec-aapl case)");

  test("a saved SEC sheet downloads instead of 404ing", () => {
    assertEqual(secServed.status, 200, `200 for ${secKey}`);
    assertEqual(sheet(secServed.wb, "Cover").getCell("A1").value, secTs.entity.companyName, "Apple's workbook");
  });

  registerCommonChecks("SEC", () => ({ served: secServed, ts: secTs }));

  test("SEC: a USD filer's inputs are labelled USD", () => {
    const inputs = sheet(secServed.wb, "Inputs");
    assertEqual(inputs.getCell(INPUT_ROW.cash, INPUT_COLS.unit).value, "USD", "unit from the fact");
  });

  suite("model live / the demo fixture");

  test("a bundled demo key still downloads for any tenant", () => {
    assertEqual(fixtureServed.status, 200, "meridian");
    assertEqual(sheet(fixtureServed.wb, "Inputs").getCell(INPUT_ROW.operatingProfit, INPUT_COLS.latest).value, 6_400_000, "EBIT from the fixture");
  });

  suite("model live / brand");

  test("workbook colours are brand/tokens.json's light theme, and its fonts the office faces", () => {
    const t = loadJson(join(HERE, "..", "..", "brand", "tokens.json"));
    for (const [k, brandKey] of Object.entries(MODEL_BRAND_COLOUR)) {
      const hex = t.color.light[brandKey] as string;
      assert(/^#[0-9A-Fa-f]{6}$/.test(hex ?? ""), `brand colour ${brandKey} exists`);
      assertEqual(MODEL_TOKENS.colour[k as keyof typeof MODEL_BRAND_COLOUR], `FF${hex.slice(1).toUpperCase()}`, `colour ${k} is ${brandKey}`);
    }
    assertEqual(MODEL_TOKENS.font.text, t.font["office-serif"], "words in the office serif");
    assertEqual(MODEL_TOKENS.font.figure, t.font["office-mono"], "figures in the office mono");
  });
}
