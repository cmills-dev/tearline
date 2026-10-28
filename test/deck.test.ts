// test/deck.test.ts
// The branded deck (WP-BE09). Three names: the two demo fixtures (Meridian, Redacta) and Tesco from
// its recorded ESEF filing, plus a sheet carrying a debt-note facilities table. The deck must print
// only figures the sheet already shows, keep abstentions visible, carry the not-advice and OGL
// lines, stay on the brand tokens, and answer 401/404/409 exactly as the other exports do.
// In memory, no network, no model call.

import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { suite, test, assert, assertEqual } from "./harness";
import { tearSheetForKey } from "../lib/engine/pipeline";
import { assembleTearSheet, type TearSheet } from "../lib/engine/assemble";
import { fixtureFromManifest, saveManifest } from "../lib/workspace";
import { mapEsefToManifest, type EsefDoc } from "../lib/sources/esef";
import { InMemoryRunStore } from "../lib/run/store";
import { emptyStages, type RunRecord } from "../lib/run/types";
import { buildDeck, deckFigures, LIMITS } from "../lib/deck/slides";
import { renderDeckHtml, deckCsp, AUTOPRINT_HASH, esc } from "../lib/deck/html";
import { serveDeck } from "../lib/deck/serve";
import { DECK_TOKENS } from "../lib/deck/tokens";
import type { CapitalStructure, FactManifest, FacilityCell } from "../lib/engine/types";

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW = "2026-09-26T03:00:00.000Z";
const TESCO = JSON.parse(readFileSync(join(HERE, "fixtures", "tesco_esef.json"), "utf8")) as EsefDoc;

function tescoManifest(): FactManifest {
  return mapEsefToManifest("2138002P5RNKC5W2JZ46", "TESCO PLC", "fxo-test", TESCO)!;
}
const sheetOf = (m: FactManifest): TearSheet => assembleTearSheet(m, fixtureFromManifest(m));

const cell = (text: string | null, status: FacilityCell["status"] = "agreed", reason: string | null = null): FacilityCell => ({
  status, text: status === "agreed" ? text : null, pounds: null, page: 41, reason,
});
function withFacilities(ts: TearSheet): TearSheet {
  const cs: CapitalStructure = {
    status: "found", reason: null, verifier: "facility-read/v1", transactionId: "tx", pages: [41, 42],
    noteHeading: "18. Borrowings", scaleCaption: "£m", fulcrumStated: false, notes: [],
    rows: [
      { id: "f1", status: "found", name: "Senior term loan B", type: "term_loan", page: 41, citation: "p.41", reason: null,
        cells: { drawn: cell("250.0"), committed: cell("250.0"), maturity: cell("March 2029"), rateOrMargin: cell("SONIA + 4.25%"), security: cell("Fixed and floating charge"), lender: cell(null, "not-printed", "not printed"), ranking: cell(null, "not-printed", "not printed") } },
      { id: "f2", status: "found", name: "Revolving credit facility", type: "revolving_credit_facility", page: 41, citation: "p.41", reason: null,
        cells: { drawn: cell("undrawn"), committed: cell("40.0"), maturity: cell(null, "abstain", "the two reads disagree"), rateOrMargin: cell(null, "not-printed", "x"), security: cell("Pari passu with the term loan"), lender: cell(null, "not-printed"), ranking: cell(null, "not-printed") } },
      { id: "f3", status: "abstain", name: null, type: null, page: 42, citation: "p.42", reason: "one read only",
        cells: { drawn: cell(null, "abstain"), committed: cell(null, "abstain"), maturity: cell(null, "abstain"), rateOrMargin: cell(null, "abstain"), security: cell(null, "abstain"), lender: cell(null, "abstain"), ranking: cell(null, "abstain") } },
    ],
  };
  return { ...ts, facilities: cs };
}

// Every display string the sheet itself shows: tiles, financials cells and deltas, capital rows,
// and facility cells as the note printed them.
function sheetDisplays(ts: TearSheet): Set<string> {
  const s = new Set<string>();
  ts.tiles.forEach((t) => s.add(t.display));
  for (const r of ts.financials.rows) {
    r.cells.forEach((c) => s.add(c.display));
    if (r.delta.status === "computed") s.add(`${r.delta.absDisplay} (${r.delta.pctDisplay})`);
  }
  ts.capital.forEach((c) => s.add(c.display));
  for (const row of ts.facilities?.rows ?? []) for (const c of Object.values(row.cells)) if (c.text) s.add(c.text);
  return s;
}

const unescape = (h: string) => h.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const printedFigures = (html: string) => [...html.matchAll(/<span[^>]*data-figure[^>]*>([^<]*)<\/span>/g)].map((m) => unescape(m[1]));

const NAMES: [string, () => TearSheet][] = [
  ["meridian", () => tearSheetForKey("meridian")!],
  ["redacta", () => tearSheetForKey("redacta")!],
  ["tesco (ESEF, recorded)", () => sheetOf(tescoManifest())],
  ["tesco with a debt-note facilities table", () => withFacilities(sheetOf(tescoManifest()))],
];

suite("deck / every figure is the sheet's own");

for (const [name, load] of NAMES) {
  test(`${name}: six slides in the backlog's order, and every printed figure is on the sheet`, () => {
    const ts = load();
    assert(!!ts, "sheet loads");
    const deck = buildDeck(ts, { sheetKey: name, generatedAt: NOW });
    assertEqual(deck.slides.map((s) => s.kind).join(","), "title,snapshot,financials,capital,catalysts,sources", "slide order");
    const known = sheetDisplays(ts);
    for (const f of deckFigures(deck)) assert(known.has(f), `${name}: deck figure "${f}" is not on the sheet`);
    const html = renderDeckHtml(deck);
    const printed = printedFigures(html).filter((f) => f !== "abstained");
    assert(printed.length > 0, `${name}: the deck prints figures`);
    for (const f of printed) assert(known.has(f), `${name}: printed figure "${f}" is not on the sheet`);
    assertEqual((html.match(/<section class="slide"/g) ?? []).length, 6, "six pages");
    assert(html.includes(esc(DECK_TOKENS.notAdvice)), "not-advice line");
    assert(html.includes(esc(DECK_TOKENS.oglAttribution)), "OGL attribution");
  });
}

test("an abstained figure prints as abstained, never as a blank or a zero", () => {
  const ts = tearSheetForKey("redacta")!;
  const r4 = ts.financials.rows.flatMap((r) => r.cells).filter((c) => c.rung === "R4");
  const html = renderDeckHtml(buildDeck(ts, { sheetKey: "redacta", generatedAt: NOW }));
  if (r4.length) assert(html.includes('class="abstain" data-figure>abstained'), "R4 cell shows abstained");
  assert(!/data-figure><\/span>/.test(html), "no empty figure cell");
});

test("the facilities slide keeps the note's order and words, and names its abstentions", () => {
  const ts = withFacilities(sheetOf(tescoManifest()));
  const deck = buildDeck(ts, { sheetKey: "t", generatedAt: NOW });
  const cap = deck.slides.find((s) => s.kind === "capital");
  assert(cap?.kind === "capital", "capital slide");
  if (cap?.kind !== "capital") return;
  assertEqual(cap.facilities.rows.map((r) => r.name).join("|"), "Senior term loan B|Revolving credit facility|abstained: one read only", "note order, abstained row named");
  assertEqual(cap.facilities.rows[1].cells.drawn, "undrawn", "undrawn stays words");
  assertEqual(cap.facilities.rows[1].cells.maturity, "abstained", "abstained cell");
  assertEqual(cap.facilities.rows[1].cells.rateOrMargin, "not printed", "not printed cell");
  const html = renderDeckHtml(deck);
  assert(html.includes("pages 41, 42") && html.includes("Unit as printed: £m"), "pages and unit caption");
  assert(html.includes("No seniority or fulcrum is inferred"), "no fulcrum claim");
});

test("a sheet with no debt note says so rather than showing an empty table", () => {
  const ts = { ...sheetOf(tescoManifest()), facilities: null };
  const html = renderDeckHtml(buildDeck(ts, { sheetKey: "t", generatedAt: NOW }));
  assert(html.includes("Facilities from the debt note: not read."), "honest absence");
});

test("rows past the page limit are counted on the slide, not dropped silently", () => {
  const ts = sheetOf(tescoManifest());
  const many = { ...ts, financials: { ...ts.financials, rows: Array.from({ length: LIMITS.financialRows + 3 }, () => ts.financials.rows[0]) } };
  const html = renderDeckHtml(buildDeck(many, { sheetKey: "t", generatedAt: NOW }));
  assert(html.includes("3 more rows on the sheet and in the model."), "overflow counted");
});

test("the synthetic demo carries the SYNTHETIC EXAMPLE stamp, a real filer does not", () => {
  const demo = renderDeckHtml(buildDeck(tearSheetForKey("meridian")!, { sheetKey: "meridian", generatedAt: NOW }));
  const real = renderDeckHtml(buildDeck(sheetOf(tescoManifest()), { sheetKey: "t", generatedAt: NOW }));
  assert(demo.includes("SYNTHETIC EXAMPLE"), "demo stamped");
  assert(!real.includes("SYNTHETIC EXAMPLE"), "real not stamped");
});

test("text from a filing is escaped", () => {
  const ts = sheetOf(tescoManifest());
  const evil = { ...ts, entity: { ...ts.entity, companyName: '<script>alert(1)</script> & "Co"' } };
  const html = renderDeckHtml(buildDeck(evil, { sheetKey: "t", generatedAt: NOW }));
  assert(!html.includes("<script>alert"), "no raw script");
  assert(html.includes("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;Co&quot;"), "escaped");
});

suite("deck / brand");

test("deck colours are brand/tokens.json's light theme, and the name is its placeholder", () => {
  const path = join(HERE, "..", "..", "brand", "tokens.json");
  assert(existsSync(path), "brand/tokens.json exists (WP-BR05)");
  const t = JSON.parse(readFileSync(path, "utf8"));
  for (const [k, v] of Object.entries(DECK_TOKENS.colour)) assertEqual(v, t.color.light[k], `colour ${k}`);
  assertEqual(DECK_TOKENS.name, t.brand.name, "name");
  assertEqual(DECK_TOKENS.notAdvice, t.brand.notAdvice, "not-advice line");
  assertEqual(DECK_TOKENS.oglAttribution, t.brand.oglAttribution, "OGL line");
});

test("Georgia and Courier New, no web font, no image, no stray hex outside the tokens", () => {
  const html = renderDeckHtml(buildDeck(tearSheetForKey("meridian")!, { sheetKey: "meridian", generatedAt: NOW }));
  assert(html.includes("Georgia") && html.includes("Courier New"), "office faces");
  assert(!/@font-face|<img|url\(/.test(html), "no font, image or url fetch");
  const allowed = new Set(Object.values(DECK_TOKENS.colour).map((c) => c.toLowerCase()));
  const hexes = [...html.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((m) => m[0].toLowerCase());
  for (const h of hexes) assert(allowed.has(h), `stray hex ${h}`);
  for (const f of ["slides.ts", "html.ts", "serve.ts", "tokens.ts"]) {
    const src = readFileSync(join(HERE, "..", "lib", "deck", f), "utf8");
    assert(!src.includes("\u2014"), `no em-dash in the deck's own copy (${f})`);
  }
});

test("16:9 landscape pages, one per slide", () => {
  const html = renderDeckHtml(buildDeck(tearSheetForKey("meridian")!, { sheetKey: "meridian", generatedAt: NOW }));
  assert(html.includes("@page { size: 13.333in 7.5in; margin: 0; }"), "page size");
  assert(html.includes("break-after: page"), "page breaks");
});

suite("deck / serve");

const TENANT_A = "tenant-deck-a";
const TENANT_B = "tenant-deck-b";
const KEY = "esef-2138002P5RNKC5W2JZ46-deck";
function runRecord(over: Partial<RunRecord>): RunRecord {
  return {
    id: "run-deck-1", tenantId: TENANT_A, input: "tesco", status: "done", stages: emptyStages(),
    startedAt: NOW, endedAt: NOW, elapsedMs: 0, sheetKey: KEY, companyNumber: null, companyName: "TESCO PLC",
    candidates: null, abstentions: [], reason: null, ...over,
  };
}

test("200 by key and by run id, 401 signed out, 404 other tenant, 409 no sheet yet", async () => {
  await saveManifest(TENANT_A, KEY, tescoManifest());
  const runStore = new InMemoryRunStore();
  await runStore.save(runRecord({}));
  await runStore.save(runRecord({ id: "run-deck-2", sheetKey: null, status: "running" }));
  const deps = { runStore, now: () => new Date(NOW) };

  const byKey = await serveDeck(TENANT_A, KEY, {}, deps);
  assertEqual(byKey.status, 200, "by key");
  assert(byKey.headers.get("content-type")!.startsWith("text/html"), "html");
  assertEqual(byKey.headers.get("cache-control"), "private, no-store", "never in a shared cache");
  assertEqual(byKey.headers.get("content-security-policy"), deckCsp(false), "no script allowed");
  assert(!byKey.headers.get("content-disposition"), "inline by default, for printing");
  const body = await byKey.text();
  assert(body.includes("TESCO PLC"), "the tenant's sheet");

  const byRun = await serveDeck(TENANT_A, "run-deck-1", {}, deps);
  assertEqual(byRun.status, 200, "by run id");

  assertEqual((await serveDeck("", KEY, {}, deps)).status, 401, "signed out");
  assertEqual((await serveDeck(TENANT_B, KEY, {}, deps)).status, 404, "another tenant's sheet");
  assertEqual((await serveDeck(TENANT_B, "run-deck-1", {}, deps)).status, 404, "another tenant's run");
  assertEqual((await serveDeck(TENANT_A, "no-such-key", {}, deps)).status, 404, "unknown key");
  assertEqual((await serveDeck(TENANT_A, "  ", {}, deps)).status, 404, "blank key");
  const pending = await serveDeck(TENANT_A, "run-deck-2", {}, deps);
  assertEqual(pending.status, 409, "run with no sheet");
});

test("print opens the dialog through one hashed script, download sends an attachment with no script", async () => {
  await saveManifest(TENANT_A, KEY, tescoManifest());
  const deps = { runStore: new InMemoryRunStore(), now: () => new Date(NOW) };
  const print = await serveDeck(TENANT_A, KEY, { print: true }, deps);
  assert(print.headers.get("content-security-policy")!.includes(`'${AUTOPRINT_HASH}'`), "script allowed by hash only");
  assert((await print.text()).includes("window.print()"), "autoprint script present");
  const dl = await serveDeck(TENANT_A, KEY, { download: true, print: true }, deps);
  assert(dl.headers.get("content-disposition")!.startsWith('attachment; filename="tesco-plc-deck-2026-09-26.html"'), "attachment name");
  assert(!(await dl.text()).includes("window.print()"), "no script in a download");
});

test("a deck for three names builds well under 10 seconds", () => {
  const t0 = Date.now();
  for (const [, load] of NAMES.slice(0, 3)) renderDeckHtml(buildDeck(load(), { sheetKey: "x", generatedAt: NOW }));
  const ms = Date.now() - t0;
  assert(ms < 10_000, `three decks took ${ms} ms`);
});
