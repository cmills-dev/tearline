// test/references.test.ts
// The references pack (WP-BE11), on a recorded run. The sheet is Bristol Water's (02662226),
// built the way a live run builds it: the frozen 28-page scan, the recorded first read
// (test/fixtures/vision/bristol-water-02662226.json) and the recorded second read
// (verify/02662226-second.json) replayed through the real Anthropic provider with a fetch that
// answers from the recording, the real double-read verifier, the real mapper, the run's own
// basis label pass and the real assembler. No network and no model call.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { suite, test, assert, assertEqual } from "./harness";
import { InMemoryCache } from "../lib/cache/cache";
import { AnthropicProvider } from "../lib/llm/providers/anthropic";
import { readScannedAccounts } from "../lib/vision/client";
import { DoubleReadVerifier, applyVerification } from "../lib/vision/verify";
import { visionLines } from "../lib/sources/visionAccounts";
import { mapLiveToManifest } from "../lib/sources/companiesHouseLive";
import { selectLatestAccountsFiling } from "../lib/resolve/filings";
import { labelFigures } from "../lib/engine/figureBasis";
import { assembleTearSheet, toCsv, type TearSheet } from "../lib/engine/assemble";
import { fixtureFromManifest, saveManifest } from "../lib/workspace";
import { tearSheetForKey } from "../lib/engine/pipeline";
import { InMemoryRunStore } from "../lib/run/store";
import { emptyStages, type RunRecord } from "../lib/run/types";
import { referenceRows, filingLink } from "../lib/references/rows";
import { buildReferencesPack } from "../lib/references/pack";
import { csvCell, neutraliseCell } from "../lib/references/csv";
import { serveReferences, parseFormat } from "../lib/references/serve";
import type { FactManifest } from "../lib/engine/types";
import type { ChFilingItem } from "../lib/resolve/types";
import type { ChargesList, CompanyProfile } from "../lib/sources/companiesHouse";

const HERE = dirname(fileURLToPath(import.meta.url));
const FX = join(HERE, "fixtures", "vision");
const GOLD = join(HERE, "..", "eval", "gold", "fixtures", "uk", "02662226-2026-03-31");
const loadJson = (rel: string) => JSON.parse(readFileSync(join(FX, rel), "utf8"));

const NUMBER = "02662226";
const TX = "MzU0MjkxMjg1OGFkaXF6a2N4";
const PAGES = 28;
const FIXED_NOW = "2026-09-25T15:30:00.000Z";

const PROFILE: CompanyProfile = {
  company_name: "BRISTOL WATER PLC",
  company_number: NUMBER,
  company_status: "active",
  date_of_creation: "1991-10-18",
  type: "plc",
  jurisdiction: "england-wales",
  sic_codes: ["36000"],
  registered_office_address: { address_line_1: "Bridgwater Road", locality: "Bristol", country: "England" },
  accounts: { accounting_reference_date: { day: "31", month: "03" }, last_accounts: { made_up_to: "2026-03-31", type: "full" }, next_due: "2026-12-31" },
};

const FILINGS: ChFilingItem[] = [
  {
    transaction_id: TX,
    category: "accounts",
    type: "AA",
    description: "accounts-with-accounts-type-full",
    description_values: { made_up_date: "2026-03-31" },
    date: "2026-09-11",
    pages: PAGES,
    links: { document_metadata: "https://document-api.company-information.service.gov.uk/document/FROZEN" },
  },
];

function replay(response: unknown): AnthropicProvider {
  return new AnthropicProvider(
    { provider: "anthropic", model: "claude-opus-5", apiKey: "replay", maxTokens: 1024 },
    {
      fetchImpl: async () => new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } }),
      logUsage: () => {},
      sleep: async () => {},
    } as never
  );
}

let recorded: Promise<{ manifest: FactManifest; ts: TearSheet }> | null = null;

// The recorded run, built once and shared. Each caller gets its own copy of the manifest.
function recordedRun(): Promise<{ manifest: FactManifest; ts: TearSheet }> {
  recorded ??= (async () => {
    const pdfBytes = () => new Uint8Array(readFileSync(join(GOLD, "filing.pdf")));
    const read = await readScannedAccounts(
      { pdfBytes: pdfBytes(), transactionId: TX, companyNumber: NUMBER, pageCount: PAGES },
      { provider: replay(loadJson("bristol-water-02662226.json").response), cache: new InMemoryCache(), pageFindingAbovePages: 200 }
    );
    const result = await new DoubleReadVerifier({ provider: replay(loadJson("verify/02662226-second.json").response), cache: new InMemoryCache() }).verify({
      read,
      pdfBytes: pdfBytes(),
      pageCount: PAGES,
    });
    const applied = applyVerification(read, result);
    const vision = visionLines(applied.read, applied.tags, null);
    const filing = selectLatestAccountsFiling(FILINGS);
    const manifest = mapLiveToManifest(PROFILE, { items: [] } as unknown as ChargesList, { vision, filing });
    // The run's own label pass for a sheet of the company's own figures (lib/run/stages/group.ts).
    labelFigures(manifest, {
      kind: "own",
      entity: { number: NUMBER, name: PROFILE.company_name },
      accountsType: "full",
      filing: { madeUpDate: "2026-03-31", transactionId: TX },
      parentNote: null,
    });
    const ts = assembleTearSheet(manifest, fixtureFromManifest(manifest));
    return { manifest, ts };
  })();
  return recorded.then(({ manifest, ts }) => ({ manifest: structuredClone(manifest), ts }));
}

// A minimal CSV reader for the tests: quoted fields, doubled quotes, CRLF rows.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\r" && s[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
suite("references / CSV cells a spreadsheet cannot execute");

test("every formula trigger is neutralised, plain numbers are left alone", () => {
  for (const bad of ["=1+1", "+1+1", "-1+1", "@SUM(A1)", "\t=1", "\r=1", " =HYPERLINK(\"http://x\")", " =1", "-2e3*A1", "=cmd|' /C calc'!A0"]) {
    assert(neutraliseCell(bad).startsWith("'"), `neutralised: ${JSON.stringify(bad)} -> ${JSON.stringify(neutraliseCell(bad))}`);
  }
  for (const ok of ["-1400000", "25100000", "+3.5", "0.25", "1e6", "-.5", "(1.4)", "£m", "Note 21, p.18", ""]) {
    assertEqual(neutraliseCell(ok), ok, `left alone: ${JSON.stringify(ok)}`);
  }
});

test("quoting still follows RFC 4180 after the guard", () => {
  assertEqual(csvCell('a "b", c'), '"a ""b"", c"', "quotes doubled and the field quoted");
  assertEqual(csvCell('=HYPERLINK("http://evil","x")'), `"'=HYPERLINK(""http://evil"",""x"")"`, "guarded, then quoted");
  assertEqual(csvCell(null), "", "null is an empty cell");
  assertEqual(csvCell(42), "42", "a number is written as a number");
});

// ---------------------------------------------------------------------------
suite("references / the pack on a recorded run (Bristol Water, 02662226)");

test("every figure on the sheet is a row, in the sheet CSV's order, with its card hash", async () => {
  const { ts } = await recordedRun();
  const rows = referenceRows(ts).filter((r) => r.kind === "figure");
  assertEqual(rows.length, Object.keys(ts.evidence).length, "one row per evidence card");
  assertEqual(rows.length, ts.exportRows.length, "as many rows as the sheet's own CSV");
  const sheetHashes = ts.exportRows.map((r) => r.contentHash).join(",");
  assertEqual(rows.map((r) => r.cardHash).join(","), sheetHashes, "card hashes match the sheet CSV, row for row");
  for (const r of rows) {
    const exp = ts.exportRows.find((e) => e.contentHash === r.cardHash)!;
    assertEqual(r.value, exp.value, `${r.figureId} value is the stored value`);
    assertEqual(r.unit, exp.unit, `${r.figureId} unit`);
  }
});

test("each scan-read figure names its page, printed text, tags, scale, link and source hash", async () => {
  const { ts } = await recordedRun();
  // R1 only: a proxy (R3) that stands on a scan-read input carries that input's provenance, and
  // says what stood in via its derivation cell instead.
  const scan = referenceRows(ts).filter((r) => r.kind === "figure" && r.printedText && r.rung === "R1");
  assert(scan.length >= 6, `the recorded run surfaces its double-read figures (${scan.length})`);
  for (const r of scan) {
    assert(Number.isInteger(r.page) && r.page! >= 1 && r.page! <= PAGES, `${r.figureId} page ${r.page}`);
    assert(r.tags.includes("double-read"), `${r.figureId} tagged double-read`);
    assert(r.scaleCaption.length > 0, `${r.figureId} scale caption`);
    assert(r.scaleMultiplier !== null && r.scaleMultiplier >= 1, `${r.figureId} scale multiplier`);
    assert(/^fnv1a:[0-9a-f]{16}$/.test(r.sourceHash), `${r.figureId} source hash ${r.sourceHash}`);
    assertEqual(
      r.link,
      `https://find-and-update.company-information.service.gov.uk/company/${NUMBER}/filing-history/${TX}/document?format=pdf&download=0#page=${r.page}`,
      `${r.figureId} links to the filing at its page`
    );
    assert(r.basis.length > 0, `${r.figureId} carries its basis sentence`);
  }
});

test("the printed figure times the scale is the stored value, for every scan-read figure", async () => {
  const { ts } = await recordedRun();
  for (const r of referenceRows(ts).filter((x) => x.kind === "figure" && x.printedText && x.rung === "R1")) {
    const printed = r.printedText.replace(/[£,\s]/g, "");
    const magnitude = Number(printed.replace(/[()\-]/g, ""));
    if (!Number.isFinite(magnitude)) continue; // a dash printed for nil
    const pounds = Math.round(magnitude * r.scaleMultiplier! * 100) / 100;
    assertEqual(Math.abs(Number(r.value)), pounds, `${r.figureId}: ${r.printedText} x${r.scaleMultiplier}`);
  }
});

test("net assets carries the tie-pass the recorded reads earned", async () => {
  const { ts } = await recordedRun();
  const na = referenceRows(ts).find((r) => r.figureId.startsWith("netAssets.") || /net assets/i.test(r.label))!;
  assert(!!na, "net assets is on the sheet");
  assert(na.tags.includes("double-read") && na.tags.includes("tie-pass"), `tags: ${na.tags.join(", ")}`);
  assertEqual(na.value, "25100000", "25.1 under £m");
});

test("a register fact keeps its register link and is never linked to the accounts PDF", async () => {
  const { ts } = await recordedRun();
  const reg = referenceRows(ts).filter((r) => r.kind === "figure" && r.sourceTag === "Reg");
  assert(reg.length > 0, "the sheet holds register facts");
  for (const r of reg) {
    assert(!r.link.includes("/document?"), `${r.figureId} is not linked to the accounts document: ${r.link}`);
    assertEqual(r.link, r.locator, `${r.figureId} links to its register locator`);
  }
});

test("derived and abstained figures say how they were made or why they are missing", async () => {
  const { ts } = await recordedRun();
  const rows = referenceRows(ts).filter((r) => r.kind === "figure");
  for (const r of rows.filter((x) => x.rung === "R2")) assert(r.derivation.length > 0, `${r.figureId} has its formula`);
  for (const r of rows.filter((x) => x.rung === "R4")) {
    assertEqual(r.value, "", `${r.figureId} holds no value`);
    assertEqual(r.display, "abstained", `${r.figureId} says so in words, not with a dash`);
    assert(r.abstainReason.length > 0, `${r.figureId} says why it abstained`);
  }
});

test("the CSV twin has one line per row, the same header everywhere, and the pack hash of its text", async () => {
  const { ts } = await recordedRun();
  const pack = buildReferencesPack(ts, { sheetKey: `ch-${NUMBER}`, generatedAt: FIXED_NOW });
  assert(pack.csv.startsWith("﻿"), "UTF-8 byte order mark for Excel");
  const parsed = parseCsv(pack.csv);
  assertEqual(parsed.length, pack.rows.length + 1, "header plus one line per row");
  const width = parsed[0].length;
  assert(parsed.every((r) => r.length === width), "every line has the header's width");
  assertEqual(parsed[0][0], "ref", "header first");
  assert(pack.html.includes(pack.packHash), "the HTML prints the CSV's hash");
  const again = buildReferencesPack(ts, { sheetKey: `ch-${NUMBER}`, generatedAt: FIXED_NOW });
  assertEqual(again.packHash, pack.packHash, "the pack is deterministic");
  assertEqual(again.html, pack.html, "and so is its HTML");
});

test("the HTML lists every row by its ref, links to the filing and carries no script", async () => {
  const { ts } = await recordedRun();
  const pack = buildReferencesPack(ts, { generatedAt: FIXED_NOW });
  for (const r of pack.rows) assert(pack.html.includes(`id="${r.ref}"`), `row ${r.ref} present`);
  assert(pack.html.includes(`filing-history/${TX}/document?format=pdf&amp;download=0#page=`), "a filing link, escaped");
  assert(!/<script/i.test(pack.html), "no script");
  assert(!/(src|href)="(?!https?:)/i.test(pack.html.replace(/<a href="https?:[^"]+"/g, "")), "no relative or non-http resource");
  assert(!pack.html.includes("—"), "no em-dash");
  assert(pack.html.includes("@page { size: A4"), "prints on A4");
});

// ---------------------------------------------------------------------------
suite("references / hostile text from a filing stays text");

test("a printed text or document name that is a formula or markup is neutralised in both twins", async () => {
  const { manifest } = await recordedRun();
  const f = Object.values(manifest.facts).find((x) => x.provenance?.printedText)!;
  f.provenance!.printedText = '=HYPERLINK("http://evil.example","25.1")';
  f.provenance!.documentName = '<img src=x onerror=alert(1)>@SUM(1)';
  f.provenance!.locator = "javascript:alert(1)";
  const ts = assembleTearSheet(manifest, fixtureFromManifest(manifest));
  const pack = buildReferencesPack(ts, { generatedAt: FIXED_NOW });

  const parsed = parseCsv(pack.csv);
  const header = parsed[0];
  const row = parsed.find((r) => r[header.indexOf("figure_id")] === f.id)!;
  assert(row[header.indexOf("printed_text")].startsWith("'="), "printed text is guarded in the CSV");
  assert(row[header.indexOf("source_document")].startsWith("<img"), "text that is not a formula is left as it is");
  for (const cells of parsed.slice(1)) {
    for (const c of cells) assert(!/^[\s ]*[=+@\t\r]/.test(c) && !(/^[\s ]*-/.test(c) && !/^-?\d+(\.\d+)?$/.test(c)), `no live formula: ${c}`);
  }

  assert(!pack.html.includes("<img"), "markup is escaped in the HTML");
  assert(pack.html.includes("&lt;img src=x onerror=alert(1)&gt;"), "and shown as text");
  assert(!pack.html.includes('href="javascript:'), "a non-http locator is never a link");
});

test("the sheet's own CSV download is guarded too", async () => {
  const { manifest } = await recordedRun();
  const f = Object.values(manifest.facts).find((x) => x.provenance?.printedText)!;
  f.provenance!.documentName = "=1+1";
  const ts = assembleTearSheet(manifest, fixtureFromManifest(manifest));
  const csv = toCsv(ts.exportRows);
  assert(!csv.split("\r\n").some((line) => line.split(",").some((c) => c === "=1+1")), "no bare formula cell");
  assert(csv.includes("'=1+1"), "the formula is written as text");
  assert(csv.includes(",-") || !ts.exportRows.some((r) => r.value.startsWith("-")), "negative numbers stay numbers");
});

test("a filing link is only built from a well-formed number and transaction", () => {
  assertEqual(filingLink({ companyNumber: "02662226", transactionId: "abc\"><x", page: 3, locator: null }), "", "a bad transaction id makes no link");
  assertEqual(filingLink({ companyNumber: "0266/2226", transactionId: TX, page: 3, locator: null }), "", "a bad number makes no link");
  assertEqual(filingLink({ companyNumber: null, transactionId: null, page: null, locator: "javascript:alert(1)" }), "", "a non-http locator is not a link");
  assertEqual(filingLink({ companyNumber: null, transactionId: null, page: null, locator: "https://www.sec.gov/x" }), "https://www.sec.gov/x", "an http locator is");
});

// ---------------------------------------------------------------------------
suite("references / a fixture sheet with no scan (meridian)");

test("the demo sheet builds a pack, and every held figure names a source or a formula", () => {
  const ts = tearSheetForKey("meridian")!;
  const pack = buildReferencesPack(ts, { generatedAt: FIXED_NOW });
  const figures = pack.rows.filter((r) => r.kind === "figure");
  assertEqual(figures.length, Object.keys(ts.evidence).length, "every figure");
  for (const r of figures.filter((x) => x.rung !== "R4")) {
    assert(r.sourceDocument.length > 0 || r.derivation.length > 0, `${r.figureId} names its source or formula`);
  }
  assert(pack.html.includes("Every held figure names its source or its formula."), "the coverage line says so");
  assertEqual(pack.filenameBase.endsWith("-references"), true, "filename");
});

// ---------------------------------------------------------------------------
suite("references / the download is tenant scoped");

const TENANT = "refs-tenant";
const OTHER = "refs-other-tenant";
const KEY = `ch-${NUMBER}-refs-test`;

function runRecord(over: Partial<RunRecord>): RunRecord {
  return {
    id: "run-refs-1",
    tenantId: TENANT,
    input: NUMBER,
    status: "done",
    stages: emptyStages(),
    startedAt: FIXED_NOW,
    endedAt: FIXED_NOW,
    elapsedMs: 0,
    sheetKey: KEY,
    companyNumber: NUMBER,
    companyName: PROFILE.company_name,
    candidates: null,
    abstentions: [],
    reason: null,
    ...over,
  };
}

test("the owner downloads HTML and CSV by sheet key and by run id; another tenant gets 404", async () => {
  const { manifest } = await recordedRun();
  await saveManifest(TENANT, KEY, manifest);
  const runStore = new InMemoryRunStore();
  await runStore.save(runRecord({}));
  await runStore.save(runRecord({ id: "run-refs-2", sheetKey: null, status: "running" }));
  const deps = { runStore, now: () => new Date(FIXED_NOW) };

  const html = await serveReferences(TENANT, KEY, null, deps);
  assertEqual(html.status, 200, "HTML by key");
  assert(html.headers.get("content-type")!.startsWith("text/html"), "HTML type");
  assert(html.headers.get("content-disposition")!.includes("bristol-water-plc-references.html"), "HTML filename");
  assertEqual(html.headers.get("cache-control"), "private, no-store", "never cached by a shared cache");
  assert(html.headers.get("content-security-policy")!.includes("default-src 'none'"), "no script can run");

  const csv = await serveReferences(TENANT, "run-refs-1", "csv", deps);
  assertEqual(csv.status, 200, "CSV by run id");
  assert(csv.headers.get("content-type")!.startsWith("text/csv"), "CSV type");
  const text = await csv.text();
  assertEqual(csv.headers.get("x-references-pack-hash"), buildReferencesPack((await recordedRun()).ts).packHash, "the pack hash header matches the pack");
  assert(text.includes(TX), "the CSV carries the filing link");

  assertEqual((await serveReferences(OTHER, KEY, "csv", deps)).status, 404, "another tenant: 404 by key");
  assertEqual((await serveReferences(OTHER, "run-refs-1", "csv", deps)).status, 404, "another tenant: 404 by run id");
  assertEqual((await serveReferences("", KEY, "csv", deps)).status, 401, "signed out: 401");
  assertEqual((await serveReferences(TENANT, "run-refs-2", "csv", deps)).status, 409, "a run with no sheet yet: 409");
  assertEqual((await serveReferences(TENANT, KEY, "pdf", deps)).status, 400, "an unknown format: 400");
  assertEqual((await serveReferences(TENANT, "no-such-key", "html", deps)).status, 404, "an unknown key: 404");
});

test("format parsing", () => {
  assertEqual(parseFormat(null), "html", "html by default");
  assertEqual(parseFormat(" CSV "), "csv", "case and space");
  assertEqual(parseFormat("xlsx"), null, "anything else is refused");
});
