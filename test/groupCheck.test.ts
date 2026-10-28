// test/groupCheck.test.ts
// WP-GRPCHK: a figure from a group's accounts must come from the group's statement or column, not
// the parent company's printed beside it (adversarial review 21 Sep 2026, finding 3).
//
// Two gaps, both closed here:
//   1. The scan path (WP-BE18) ran the basis check only when the register's label was exactly
//      "group". A parent that prints consolidated statements and lodges them as "full" accounts got
//      no check. Now the first read's own evidence (it took the consolidated statements, or it cited
//      a group statement heading) holds the filing to the check too.
//   2. The text-layer path took the first labelled row and the first figure on it, whoever's it
//      was. It now reads the nearest statement heading and the nearest row of column captions.
//
// Everything here is recorded: the first and second reads of five frozen UK scans, and rows
// transcribed from Boparan Holdings' frozen scan (03558065, made up 26 Jul 2025). No model call.
//
// Boparan is the filing that prints both. Its notes 19 and 20 (PDF page 90) head each table with
// GROUP and COMPANY spans over dated columns, and its company balance sheet (PDF page 62) prints
// cash at bank of 105.3 against the group's 105.4 (PDF page 59). A company-for-group swap there is
// £0.1m, which no tie and no reader would notice.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { suite, test, assert, assertEqual } from "./harness";
import { InMemoryCache } from "../lib/cache/cache";
import { AnthropicProvider } from "../lib/llm/providers/anthropic";
import { readScannedAccounts } from "../lib/vision/client";
import { DoubleReadVerifier, applyVerification, groupFilerWhy, BASIS_ABSTAIN } from "../lib/vision/verify";
import { captionSpans, isStatementHeading, printsGroupStatement } from "../lib/vision/basisWords";
import { visionLines } from "../lib/sources/visionAccounts";
import { extractFinancialsFromText } from "../lib/sources/pdfAccounts";
import { mapLiveToManifest } from "../lib/sources/companiesHouseLive";
import type { AccountsTypeLabel } from "../lib/resolve/accountsType";
import type { BaseLineKey, VisionReadResult } from "../lib/vision/types";
import { stageOf } from "./pageFindingCases";
import { replayGoldFirstRead } from "./goldFirstRead";
import { UK_GOLD } from "../eval/gold/uk";

const HERE = dirname(fileURLToPath(import.meta.url));
const FX = join(HERE, "fixtures", "vision");
const GOLD = join(HERE, "..", "eval", "gold", "fixtures", "uk");
const load = (rel: string) => JSON.parse(readFileSync(join(FX, rel), "utf8"));
const gold = (number: string) => UK_GOLD.find((g) => g.companyNumber === number && g.scan)!;
const pdf = (number: string) => new Uint8Array(readFileSync(join(GOLD, gold(number).folder, "filing.pdf")));

function provider(fetchImpl: (u: unknown, init?: RequestInit) => Promise<Response>, model = "claude-opus-5"): AnthropicProvider {
  return new AnthropicProvider({ provider: "anthropic", model, apiKey: "replay", maxTokens: 1024 }, { fetchImpl: fetchImpl as any, logUsage: () => {} });
}
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const replay = (response: unknown) => provider(async () => ok(response));

// A recorded response with its JSON answer changed, for a scripted variant of a real read.
function withAnswer(response: any, mutate?: (answer: any) => void): any {
  const copy = JSON.parse(JSON.stringify(response));
  if (!mutate) return copy;
  const block = [...copy.content].reverse().find((b: any) => b.type === "text");
  const answer = JSON.parse(block.text);
  mutate(answer);
  block.text = JSON.stringify(answer);
  return copy;
}

// The single-read recordings (WP-BE01 and WP-BE05). Bristol Water and Matalan reuse WP-BE01's.
const RECORDED: Record<string, { first: string; second: string }> = {
  "02662226": { first: "bristol-water-02662226.json", second: "verify/02662226-second.json" },
  "02103564": { first: "matalan-retail-02103564.json", second: "verify/02103564-second.json" },
  "01404552": { first: "verify/01404552-first.json", second: "verify/01404552-second.json" },
  "00769170": { first: "verify/00769170-first.json", second: "verify/00769170-second.json" },
  "03558065": { first: "verify/03558065-first.json", second: "verify/03558065-second.json" },
};

async function recordedFirstRead(number: string, mutate?: (answer: any) => void): Promise<VisionReadResult> {
  const g = gold(number);
  return replayGoldFirstRead(
    { pdfBytes: pdf(number), transactionId: g.transactionId, companyNumber: g.companyNumber, pageCount: g.pageCount },
    g.folder,
    withAnswer(load(RECORDED[number].first).response, mutate)
  );
}

async function verifyBoparan(
  accountsType: AccountsTypeLabel | null,
  opts: { first?: (answer: any) => void; second?: (answer: any) => void } = {}
) {
  const read = await recordedFirstRead("03558065", opts.first);
  const second = withAnswer(load(RECORDED["03558065"].second).response, opts.second);
  const result = await new DoubleReadVerifier({ provider: replay(second), cache: new InMemoryCache() }).verify({
    read,
    pdfBytes: pdf("03558065"),
    pageCount: gold("03558065").pageCount,
    accountsType,
  });
  const applied = applyVerification(read, result);
  return { read, result, mapped: visionLines(applied.read, applied.tags, null, { accountsType }) };
}

// The Boparan second read was a v1 answer (WP-BE05) with no basis; the WP-BE14-LIVE-2 re-recording
// (v4) states one for every line. printedBasis still writes the basis words printed over each line
// on the frozen scan (its statement heading, or the "GROUP" spanning the columns of note 21, PDF
// page 91), so each test starts from the same words whichever recording it replays. `over`
// replaces them for chosen lines.
const lineOf = (answer: any, key: BaseLineKey) => answer.lines.find((l: any) => l.key === key);
function printedBasis(over: Partial<Record<BaseLineKey, { basis: string; basis_text: string; column_heading?: string; header_rows_above?: string[] }>> = {}) {
  return (answer: any) => {
    for (const l of answer.lines) {
      l.basis = "consolidated";
      l.basis_text = /BORROWINGS/.test(l.statement) ? "GROUP" : l.statement;
      Object.assign(l, over[l.key as BaseLineKey] ?? {});
    }
  };
}
const reasonFor = (r: { overrides: Partial<Record<BaseLineKey, { reason: string }>> }, key: BaseLineKey) => r.overrides[key]?.reason ?? "";

// ---------------------------------------------------------------------------
suite("group check / who is a group filer");

test("the heading words: group statements, company statements, and a single company's group undertakings", () => {
  assert(printsGroupStatement("CONSOLIDATED BALANCE SHEET"), "consolidated balance sheet");
  assert(printsGroupStatement("Group income statement"), "group income statement");
  assert(printsGroupStatement("Notes to the consolidated financial statements continued"), "notes to the consolidated");
  assert(printsGroupStatement("Consolidated Statement of Profit or Loss"), "profit or loss");
  assert(!printsGroupStatement("COMPANY BALANCE SHEET"), "company balance sheet");
  assert(!printsGroupStatement("Amounts owed to group undertakings"), "a single company's note is not a group statement");
  assert(!printsGroupStatement("21. BORROWINGS"), "a note title says nothing");
  assert(isStatementHeading("COMPANY BALANCE SHEET") && isStatementHeading("NOTES TO THE FINANCIAL STATEMENTS"), "statement headings");
  assertEqual(JSON.stringify(captionSpans("GROUP COMPANY")), '["group","company"]', "Boparan's spans");
  assertEqual(JSON.stringify(captionSpans("Company 2025 £'000 Group 2025 £'000")), '["company","group"]', "company first");
  assertEqual(captionSpans("26 July 27 July 26 July 27 July"), null, "dates are not captions");
  assertEqual(captionSpans("Amount owed to Group undertakings - - 978.5 1,130.9"), null, "a row is not a caption");
});

test("on the recorded reads: the single companies are not held to the check, the groups are, whatever the register says", async () => {
  for (const n of ["02662226", "02103564", "01404552", "00769170"]) {
    const read = await recordedFirstRead(n);
    assertEqual(groupFilerWhy("full", read), null, `${gold(n).name}: full accounts, company statements`);
    assertEqual(groupFilerWhy(null, read), null, `${gold(n).name}: no label`);
  }
  const boparan = await recordedFirstRead("03558065");
  assertEqual(groupFilerWhy("group", boparan), "the filing is group accounts", "Boparan labelled group");
  const why = groupFilerWhy("full", boparan) ?? "";
  assert(why.includes("the first read took the consolidated statements") && why.includes('the register calls it "full" accounts'), why);
  // A first read that states no basis but cites a group statement is held by the heading. The
  // re-recorded first read (WP-BE14-LIVE-2) copies the heading in title case.
  const unstated = { ...boparan, document: { ...boparan.document, basis: null } };
  assert((groupFilerWhy("full", unstated) ?? "").includes('it prints "Consolidated profit and loss account"'), groupFilerWhy("full", unstated) ?? "");
});

// ---------------------------------------------------------------------------
suite("group check / scans lodged as full accounts (the register's label no longer decides)");

// The three large group filings, replayed from their WP-BE18 recordings, page-finding included.
async function replayPaged(number: string, accountsType: AccountsTypeLabel) {
  const g = gold(number);
  const paged = load(join("pages", `${number}.json`));
  const byStage = new Map<string, unknown>(paged.calls.map((c: any) => [c.stage, c.response]));
  const byStageProvider = (model: string) =>
    provider(async (_u, init) => {
      const r = byStage.get(stageOf(JSON.parse(String(init?.body))));
      if (!r) throw new Error("no recorded response");
      return ok(r);
    }, model);
  const reader = byStageProvider(paged.readerModel);
  const cache = new InMemoryCache();
  const bytes = pdf(number);
  const read = await readScannedAccounts(
    { pdfBytes: bytes, transactionId: g.transactionId, companyNumber: g.companyNumber, pageCount: g.pageCount },
    { provider: reader, pageFinder: byStageProvider(paged.finderModel), cache }
  );
  const result = await new DoubleReadVerifier({ provider: reader, cache }).verify({ read, pdfBytes: bytes.slice(), pageCount: g.pageCount, accountsType });
  const applied = applyVerification(read, result);
  return { read, mapped: visionLines(applied.read, applied.tags, g.madeUpDate, { accountsType }) };
}

for (const n of ["00445790", "00211475", "03213782"]) {
  test(`${gold(n).name}: lodged as "full", the check runs and every group figure still lands exactly as under "group"`, async () => {
    const asGroup = await replayPaged(n, "group");
    const asFull = await replayPaged(n, "full");
    assert(groupFilerWhy("full", asFull.read) !== null, "held to the check");
    const landed = (m: typeof asGroup.mapped) => m.figures.map((f) => `${f.key}=${f.value}`).join(",");
    assert(asGroup.mapped.figures.length > 0, "figures land");
    assertEqual(landed(asFull.mapped), landed(asGroup.mapped), "the same figures land");
    for (const f of asFull.mapped.figures) {
      assert(f.tag.evidence?.basis?.heading, `${f.key} carries the printed group heading on its record`);
    }
  });
}

test("Boparan lodged as full: a figure read from the COMPANY column of note 20 abstains, naming the column", async () => {
  // Note 20 (PDF page 90) prints GROUP and COMPANY spans over columns each headed "26 July 2025".
  // Scripted: the second read reports the span over the column it read as COMPANY.
  const company = { basis: "consolidated", basis_text: "COMPANY" };
  for (const accountsType of ["full", null] as const) {
    const { result, mapped } = await verifyBoparan(accountsType, { second: printedBasis({ borrowings_after_one_year: company }) });
    const reason = reasonFor(result, "borrowings_after_one_year");
    assert(reason.startsWith(BASIS_ABSTAIN) && reason.includes('is "COMPANY"'), `${accountsType}: ${reason}`);
    assertEqual(mapped.figures.find((f) => f.key === "borrowings_after_one_year"), undefined, `${accountsType}: not on the sheet`);
  }
});

test("Boparan lodged as full: note 20 with only its page title printed over it abstains, because the title does not say group", async () => {
  // Boparan's page title is "NOTES TO THE FINANCIAL STATEMENTS". A dated column under two spans
  // is the group's only if the read says the span. Both reads calling it consolidated is opinion.
  // The re-recorded second read copies the "GROUP" span over the column into header_rows_above
  // (WP-BE22), which is what the scan prints; the scenario is a read that saw only the page title,
  // so the header rows are emptied too.
  const titleOnly = { basis: "consolidated", basis_text: "NOTES TO THE FINANCIAL STATEMENTS", header_rows_above: [] as string[] };
  const { result } = await verifyBoparan("full", { second: printedBasis({ borrowings_after_one_year: titleOnly }) });
  const reason = reasonFor(result, "borrowings_after_one_year");
  assert(reason.includes('nothing printed for this figure says "consolidated" or "group"'), reason);
  assert(reason.includes('the register calls it "full" accounts'), reason);
});

test("Boparan lodged as full: with GROUP read over the column, the basis passes and the tie decides, as under group", async () => {
  const underFull = await verifyBoparan("full", { second: printedBasis() });
  const underGroup = await verifyBoparan("group", { second: printedBasis() });
  for (const k of ["borrowings_within_one_year", "borrowings_after_one_year"] as BaseLineKey[]) {
    const reason = reasonFor(underFull.result, k);
    assert(reason.includes("Borrowings: the maturity split adds to total borrowings failed"), `${k}: ${reason}`);
    assertEqual(reason, reasonFor(underGroup.result, k), `${k}: the same verdict as under group`);
  }
  assertEqual(
    underFull.mapped.figures.map((f) => f.key).join(","),
    underGroup.mapped.figures.map((f) => f.key).join(","),
    "the same figures land"
  );
});

test("Boparan lodged as full: cash read from the COMPANY BALANCE SHEET (105.3 against the group's 105.4) abstains", async () => {
  // Scripted from PDF page 62 as printed: both reads take the company balance sheet's cash. The
  // first read is page-found (WP-BE14-LIVE-2) and was sent PDF pages 57, 59, 61, 90, 91, 92, 96,
  // 97 and 98; page 62 is not among them, so the read cannot cite it (with pdf_page_index 62 the
  // line never reached the check). The scripted line keeps the cited page (PDF page 59) and changes
  // the words and the figure: the statement is the company's, and the figure is its 105.3.
  const toCompany = (answer: any) => {
    const l = lineOf(answer, "cash_at_bank");
    Object.assign(l, { figure_text: "105.3", statement: "COMPANY BALANCE SHEET" });
  };
  const { result, mapped } = await verifyBoparan("full", {
    first: toCompany,
    second: (a) => {
      printedBasis({ cash_at_bank: { basis: "consolidated", basis_text: "COMPANY BALANCE SHEET AS AT 26 JULY 2025" } })(a);
      Object.assign(lineOf(a, "cash_at_bank"), { figure_text: "105.3", statement: "COMPANY BALANCE SHEET AS AT 26 JULY 2025" });
    },
  });
  const reason = reasonFor(result, "cash_at_bank");
  assert(reason.startsWith(BASIS_ABSTAIN) && reason.includes('"COMPANY BALANCE SHEET"'), reason);
  assert(reason.includes('the register calls it "full" accounts'), reason);
  assertEqual(mapped.figures.find((f) => f.key === "cash_at_bank"), undefined, "not on the sheet");
});

// ---------------------------------------------------------------------------
suite("group check / the text layer reads the heading and the column captions");

// Rows transcribed from Boparan's frozen scan, as a text layer would give them, one printed line
// to a line. The scan has no text layer, so the live path never reads this filing this way; the
// rows are what a digital filing of the same pages would carry.
const P59_CONSOLIDATED = `BOPARAN HOLDINGS LIMITED
CONSOLIDATED BALANCE SHEET
AS AT 26 JULY 2025
26 July 27 July
Note 2025 2024
£m £m
Fixed assets
Intangible fixed assets 12 53.0 65.9
Tangible fixed assets 13 167.5 245.2
Investment in associate 14 - 7.4
Investment in joint venture 14 - 3.5
220.5 322.0
Current assets
Inventories 16 60.8 67.4
Debtors 17 125.6 181.8
Deferred tax asset due after more than one year 18 90.8 79.4
Cash at bank and in hand 105.4 47.2
382.6 375.8
Creditors: amounts falling due within one year 19 (341.7) (403.8)
Net current assets / ( liabilities) 40.9 (28.0)`;

const P62_COMPANY = `BOPARAN HOLDINGS LIMITED
COMPANY BALANCE SHEET
AS AT 26 JULY 2025
52 weeks 52 weeks
ended ended
26 July 27 July
Note 2025 2024
£m £m
Fixed assets
Investments 14 635.9 646.5
Current assets
Debtors 17 518.1 654.6
Deferred tax asset due after more than one year 33.6 5.0
Cash at bank and in hand 105.3 19.6
657.0 679.2
Creditors: amounts falling due within one year 19 (978.5) (1,141.0)
Net current liabilities (321.5) (461.8)`;

const P90_NOTES = `BOPARAN HOLDINGS LIMITED
NOTES TO THE FINANCIAL STATEMENTS
FOR THE 52 WEEKS ENDED 26 JULY 2025
19. CREDITORS: AMOUNTS FALLING DUE WITHIN ONE YEAR
GROUP COMPANY
26 July 27 July 26 July 27 July
2025 2024 2025 2024
£m £m £m £m
Obligations under finance leases (note 21) 0.2 1.5 - -
Bond interest accrual (note 21) 7.5 5.3 - -
Other borrowings interest accrual (note 21) - 0.3 - 0.3
Other borrowings (note 21) - 9.8 - 9.8
Trade creditors 169.9 205.1 - -
Amount owed to Group undertakings - - 978.5 1,130.9
Amount owed to related parties (note 32) 17.9 9.2 - -
Amount owed to joint venture (note 32) 62.4 68.3 - -
Other taxation and social security 9.8 10.7 - -
Other creditors 1.9 8.2 - -
Accruals and deferred income 72.1 85.3 - -
Government grants - 0.1 - -
341.7 403.8 978.5 1,141.0
Other creditors principally relate to payables in respect of tangible fixed assets.
20. CREDITORS: AMOUNTS FALLING DUE AFTER MORE THAN ONE YEAR
GROUP COMPANY
26 July 27 July 26 July 27 July
2025 2024 2025 2024
£m £m £m £m
Obligations under finance leases (note 21) - 5.2 - -
Bond notes and other borrowings (note 21) 381.6 517.8 - -
381.6 523.0 - -`;

const cashOf = (r: ReturnType<typeof extractFinancialsFromText>) => r?.lines.find((l) => l.metric === "cash");
const abstention = (r: ReturnType<typeof extractFinancialsFromText>, metric: string) => r?.abstentions.find((a) => a.metric === metric)?.reason ?? "";

test("Boparan, company balance sheet first: the group's cash is read, not the company's 105.3", () => {
  // The order a text layer gives pages is not a promise. Before this check the first "Cash at bank"
  // row won, whoever's balance sheet it sat in: here, the company's 105.3.
  const text = `${P62_COMPANY}\n${P59_CONSOLIDATED}`;
  for (const accountsType of ["group", "full"]) {
    const r = extractFinancialsFromText(text, "pdf", { accountsType })!;
    assertEqual(cashOf(r)?.value, 105_400_000, `${accountsType}: the consolidated balance sheet's cash`);
    assertEqual(cashOf(r)?.rawText, "Cash at bank and in hand 105.4 47.2", `${accountsType}: cites the group's row`);
  }
  assert((extractFinancialsFromText(text, "pdf", { accountsType: "full" })!.groupFiler ?? "").includes('it prints "CONSOLIDATED BALANCE SHEET"'), "held by the printed heading");
});

test("Boparan, company balance sheet alone on a group filing: cash abstains and names the heading", () => {
  const r = extractFinancialsFromText(P62_COMPANY, "pdf", { accountsType: "group" })!;
  assertEqual(cashOf(r), undefined, "no cash figure");
  const reason = abstention(r, "cash");
  assert(reason.startsWith(BASIS_ABSTAIN) && reason.includes('"COMPANY BALANCE SHEET"'), reason);
  assert(reason.includes('"Cash at bank and in hand 105.3 19.6"'), `names the row: ${reason}`);
});

test("a company-only filing is unaffected: the same page read as a single company's accounts gives its cash", () => {
  const r = extractFinancialsFromText(P62_COMPANY, "pdf", { accountsType: "full" })!;
  assertEqual(r.groupFiler, null, "not held to the check");
  assertEqual(cashOf(r)?.value, 105_300_000, "its own cash");
});

test("Boparan notes 19 and 20 print GROUP and COMPANY columns: the Group column is read, a blank one is not", () => {
  const r = extractFinancialsFromText(P90_NOTES, "pdf", { accountsType: "group" })!;
  const b = r.lines.find((l) => l.metric === "borrowings");
  // "Other borrowings (note 21) - 9.8 - 9.8" in note 19 prints nothing in the Group 2025 column.
  // Before this package the row was taken, and its first figure was the "21)" of "(note 21)":
  // borrowings of 21,000,000, read off a note reference.
  assertEqual(b?.value, 381_600_000, "note 20's Group 2025 figure");
  assertEqual(b?.rawText, "Bond notes and other borrowings (note 21) 381.6 517.8 - -", "cites the row");
});

test("the same notes with the spans printed COMPANY then GROUP: the first figure is the company's, so it abstains", () => {
  // Scripted: Boparan prints Group first. Some filers print Company first; the caption row decides.
  const flipped = P90_NOTES.replace(/^GROUP COMPANY$/gm, "COMPANY GROUP");
  const r = extractFinancialsFromText(flipped, "pdf", { accountsType: "group" })!;
  assertEqual(r.lines.find((l) => l.metric === "borrowings"), undefined, "no borrowings figure");
  const reason = abstention(r, "borrowings");
  assert(reason.includes("the first column prints") || reason.includes('captioned "COMPANY GROUP"'), reason);
  // The note 20 row itself is refused on its captions.
  const only20 = flipped.slice(flipped.indexOf("20. CREDITORS"));
  const r20 = extractFinancialsFromText(`NOTES TO THE FINANCIAL STATEMENTS\n${only20}`, "pdf", { accountsType: "group" })!;
  const reason20 = abstention(r20, "borrowings");
  assert(reason20.startsWith(BASIS_ABSTAIN) && reason20.includes('captioned "COMPANY GROUP"'), reason20);
});

test("the same notes with no caption rows on a group filing: nothing printed says group, so it abstains", () => {
  const bare = P90_NOTES.slice(P90_NOTES.indexOf("20. CREDITORS")).replace(/^GROUP COMPANY\n/gm, "");
  const r = extractFinancialsFromText(`NOTES TO THE FINANCIAL STATEMENTS\n${bare}`, "pdf", { accountsType: "group" })!;
  assertEqual(r.lines.find((l) => l.metric === "borrowings"), undefined, "no borrowings figure");
  const reason = abstention(r, "borrowings");
  assert(reason.startsWith(BASIS_ABSTAIN) && reason.includes('nothing printed above the row says "consolidated" or "group"'), reason);
  assert(reason.includes('(statement "NOTES TO THE FINANCIAL STATEMENTS")'), reason);
  // On a single company's accounts the same rows are its own, and the row is read.
  const single = extractFinancialsFromText(`NOTES TO THE FINANCIAL STATEMENTS\n${bare}`, "pdf", { accountsType: "full" })!;
  assertEqual(single.lines.find((l) => l.metric === "borrowings")?.value, 381_600_000, "read on a single company's accounts");
});

test("a refused line lands on the sheet as an abstention that carries the reason", () => {
  const r = extractFinancialsFromText(P62_COMPANY, "pdf", { accountsType: "group" })!;
  // Any recorded register profile will do; the one here is Pret Parent Holding's (WP-BE12).
  const profile = JSON.parse(readFileSync(join(HERE, "fixtures", "group", "profile-13383544.json"), "utf8"));
  const manifest = mapLiveToManifest(profile, { items: [] } as any, { textAbstentions: r.abstentions });
  const cash = Object.values(manifest.facts).find((f) => f.metric === "cash")!;
  assertEqual(cash.value, null, "no value");
  assertEqual(cash.rung, "R4", "abstained");
  assert((cash.attemptLog ?? []).some((e) => e.detail.includes('"COMPANY BALANCE SHEET"') && e.detail.startsWith("Abstained on")), JSON.stringify(cash.attemptLog));
});

test("a blank current-year column behind a note number is not read from the prior year (any filer)", () => {
  // Boparan's consolidated balance sheet prints "Investment in associate 14 - 7.4": note 14, nothing
  // this year, 7.4 last year. The same shape on a labelled row gave the prior year before.
  const text = "Figures in £m\nBALANCE SHEET\nNote 2025 2024\nCash at bank and in hand 14 - 7.4\nTurnover 3 1,000.0 900.0";
  const r = extractFinancialsFromText(text, "pdf", { accountsType: "full" })!;
  assertEqual(cashOf(r), undefined, "no cash figure");
  assert(abstention(r, "cash").includes('the first column prints "-"'), abstention(r, "cash"));
  assertEqual(r.lines.find((l) => l.metric === "turnover")?.value, 1_000_000_000, "a full row still reads past its note number");
});
