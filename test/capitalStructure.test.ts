// test/capitalStructure.test.ts
// The facilities table from the debt note (WP-BE16). No test makes a network call.
//
// The debt-note reads replayed here were recorded from the live API on 22 Sep 2026 by
// test/record/debtNotes.ts: the facility reads of Boparan and Solid State (the two gold filings
// with debt-note facilities) and of the three large group scans. The first reads they rest on are
// the WP-BE05 and WP-BE15 recordings, and Solid State's own. The abstain paths are proved by
// replaying a recorded facility read with one field changed, so each is exercised on a real
// answer rather than an invented one. Since WP-BE14-LIVE-2 the Boparan and large-scan reads are the
// gold re-recordings (27 Sep 2026), replayed along their recorded page-finding.
//
// THE GOLD IS PROVISIONAL. The four debt-note gold facilities are "candidate" figures in
// eval/gold/uk.ts: read by an agent and checked by Claude only. Cam's spot check (WP-BE17) has not
// run. The gold test below asserts that no agreed cell contradicts them; it does not make them
// right.

import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { suite, test, assert, assertEqual } from "./harness";
import { InMemoryCache } from "../lib/cache/cache";
import { AnthropicProvider } from "../lib/llm/providers/anthropic";
import type { LLMCallResult, LLMRequest, StructuredLLMProvider } from "../lib/llm/types";
import { readScannedAccounts } from "../lib/vision/client";
import { pdfPageCount } from "../lib/vision/pages";
import { carriesPages } from "./pdfPages";
import {
  DebtNoteFacilityReader,
  FACILITY_READ_EFFORT,
  FACILITY_READ_SCHEMA,
  debtNotePages,
  judgeFacilities,
  maturitySignature,
  normWords,
  phraseProblem,
  rateSignature,
  readAmount,
  statesRanking,
  type FacilityReadWire,
} from "../lib/vision/capitalStructure";
import type { VisionReadResult } from "../lib/vision/types";
import type { CapitalStructure, FacilityRow } from "../lib/engine/types";
import { mapLiveToFixture, mapLiveToManifest } from "../lib/sources/companiesHouseLive";
import { assembleTearSheet } from "../lib/engine/assemble";
import { fixtureFromManifest } from "../lib/workspace";
import type { ChargesList, CompanyProfile } from "../lib/sources/companiesHouse";
import { UK_GOLD } from "../eval/gold/uk";
import { compareToGold } from "../eval/gold/uk-facilities";
import { stageOf, LARGE_FILINGS } from "./pageFindingCases";
import { replayGoldFirstRead } from "./goldFirstRead";

const HERE = dirname(fileURLToPath(import.meta.url));
const FX = join(HERE, "fixtures", "vision");
const GOLD = join(HERE, "..", "eval", "gold", "fixtures", "uk");
const loadJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

// --- Replay -----------------------------------------------------------------

const answerOf = (response: any) => JSON.parse([...response.content].reverse().find((b: any) => b.type === "text").text);

function withAnswer(response: any, answer: unknown): any {
  const r = JSON.parse(JSON.stringify(response));
  [...r.content].reverse().find((b: any) => b.type === "text").text = JSON.stringify(answer);
  return r;
}

interface Replay {
  provider: AnthropicProvider;
  requests: any[];
}

// Answers each request by its stage (contents, classify:<pages>, first-read, second-read,
// facility-read), as the page-finding replay does.
function replayByStage(byStage: Map<string, any>, model = "claude-opus-5"): Replay {
  const requests: any[] = [];
  const provider = new AnthropicProvider(
    { provider: "anthropic", model, apiKey: "replay", maxTokens: 1024 },
    {
      fetchImpl: async (_u: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        requests.push(body);
        const response = byStage.get(stageOf(body));
        if (!response) throw new Error(`no recorded response for ${stageOf(body)}`);
        return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
      },
      logUsage: () => {},
      sleep: async () => {},
    } as never
  );
  return { provider, requests };
}

interface DebtCase {
  number: string;
  name: string;
  folder: string;
  transactionId: string;
  pageCount: number;
  madeUpDate: string;
}

const BOPARAN: DebtCase = { number: "03558065", name: "Boparan Holdings", folder: "03558065-2025-07-26", transactionId: "MzUxODk5OTExM2FkaXF6a2N4", pageCount: 113, madeUpDate: "2025-07-26" };
const SOLID_STATE: DebtCase = { number: "00771335", name: "Solid State", folder: "00771335-2026-03-31", transactionId: "MzUzNTQzMzAzOGFkaXF6a2N4", pageCount: 140, madeUpDate: "2026-03-31" };

const pdfCache = new Map<string, Uint8Array>();
function pdf(c: { number: string; folder: string }): Uint8Array {
  if (!pdfCache.has(c.number)) pdfCache.set(c.number, new Uint8Array(readFileSync(join(GOLD, c.folder, "filing.pdf"))));
  return pdfCache.get(c.number)!.slice();
}

const facilityRecording = (number: string) => loadJson(join(FX, "facilities", `${number}.json`));
const recordedFacilityResponse = (number: string) => facilityRecording(number).calls.find((x: any) => x.stage === "facility-read").response;

// The first read a facility recording rests on, replayed on the path it was recorded on.
const readCache = new Map<string, VisionReadResult>();
async function firstRead(c: DebtCase): Promise<VisionReadResult> {
  if (readCache.has(c.number)) return readCache.get(c.number)!;
  let read: VisionReadResult;
  if (c.number === BOPARAN.number) {
    // Since WP-BE14-LIVE-2 Boparan's first read is the gold re-recording, which was page-found, so it
    // replays through its recorded page-finding (test/goldFirstRead.ts).
    read = await replayGoldFirstRead(
      { pdfBytes: pdf(c), transactionId: c.transactionId, companyNumber: c.number, pageCount: c.pageCount },
      c.folder,
      loadJson(join(FX, "verify", "03558065-first.json")).response
    );
  } else {
    const rec = c.number === SOLID_STATE.number ? facilityRecording(c.number) : loadJson(join(FX, "pages", `${c.number}.json`));
    const byStage = new Map<string, any>(rec.calls.map((x: any) => [x.stage, x.response]));
    read = await readScannedAccounts(
      { pdfBytes: pdf(c), transactionId: c.transactionId, companyNumber: c.number, pageCount: c.pageCount },
      { provider: replayByStage(byStage).provider, pageFinder: replayByStage(byStage, rec.finderModel).provider, cache: new InMemoryCache() }
    );
  }
  readCache.set(c.number, read);
  return read;
}

async function tableFor(
  c: DebtCase,
  opts: { mutate?: (answer: FacilityReadWire) => void; accountsType?: "group" | "full" | null; read?: VisionReadResult } = {}
) {
  const read = opts.read ?? (await firstRead(c));
  const answer = answerOf(recordedFacilityResponse(c.number)) as FacilityReadWire;
  opts.mutate?.(answer);
  const replay = replayByStage(new Map([["facility-read", withAnswer(recordedFacilityResponse(c.number), answer)]]));
  const result = await new DebtNoteFacilityReader({ provider: replay.provider, cache: new InMemoryCache() }).read({
    read,
    pdfBytes: pdf(c),
    accountsType: opts.accountsType === undefined ? "group" : opts.accountsType,
  });
  return { read, table: result.table, requests: replay.requests, answer };
}

const rowNamed = (t: CapitalStructure, re: RegExp) => t.rows.find((r) => re.test(r.name ?? ""));
// Boparan's RCF: the re-recorded first read lists it under the note's own row name, "Other
// borrowings", typed as a revolving credit facility; the second read names it "Revolving Credit
// Facility (RCF)". The row carries the first read's name.
const rcfOf = (t: CapitalStructure) => t.rows.find((r) => r.type === "revolving_credit_facility");

// ---------------------------------------------------------------------------
// The gold comparison. A cell "contradicts" the gold when it is agreed and says something the gold
// does not: a different amount, a nil the gold does not have, a date or rate the gold does not
// print, or a meaningful word on security, lender or ranking that is not in the gold's field or
// its verbatim quote. An abstention is not a contradiction; it is recorded as coverage.
// ---------------------------------------------------------------------------

export interface GoldFacilityVerdict {
  company: string;
  gold: string;
  checkedBy: string; // who has checked the gold figure
  row: FacilityRow | null;
  outcome: "surfaced" | "row-abstained" | "table-abstained";
  agreed: string[];
  abstained: string[];
  contradictions: string[];
}

// compareToGold lives in eval/gold/uk-facilities.ts since WP-BE13, so the UK eval gate uses the
// same comparison. Re-exported for anything that imported it from here.
export { compareToGold };

export async function goldFacilityVerdicts(): Promise<GoldFacilityVerdict[]> {
  const out: GoldFacilityVerdict[] = [];
  for (const c of [BOPARAN, SOLID_STATE]) {
    const gold = UK_GOLD.find((x) => x.companyNumber === c.number)!;
    const { table } = await tableFor(c);
    for (const g of (gold.facilities ?? []) as any[]) {
      // The row for a gold facility: the one whose agreed committed amount is the gold's, else the
      // one of the same type. Matching on type alone never counts as a contradiction-free pass for
      // an amount, because the amount is compared below.
      const row =
        table.rows.find((r) => r.cells.committed.status === "agreed" && r.cells.committed.pounds === g.amount) ??
        table.rows.find((r) => r.type === g.type) ??
        null;
      const outcome: GoldFacilityVerdict["outcome"] = table.status === "abstain" && table.rows.length === 0 ? "table-abstained" : row?.status === "found" ? "surfaced" : "row-abstained";
      out.push({
        company: gold.name,
        gold: g.nameAsPrinted,
        checkedBy: g.status === "candidate" ? "Claude only (candidate; Cam's spot check not done)" : g.status,
        row,
        outcome,
        ...compareToGold(g, row),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

suite("capitalStructure / printed amounts and words");

test("an amount is read from the printed characters, with any unit written beside it", () => {
  const a = readAmount("£390.0m");
  assert(a.kind === "figure" && a.value === 390 && a.inlineScale === 1e6 && a.inlineCurrency === "GBP", "£390.0m");
  const b = readAmount("10,142");
  assert(b.kind === "figure" && b.value === 10142 && b.inlineScale === null, "a bare figure takes the note's caption");
  const c = readAmount("£30.0 million");
  assert(c.kind === "figure" && c.inlineScale === 1e6, "million");
  const d = readAmount("£51.0m at 31 December 2025");
  assert(d.kind === "figure" && d.value === 51, "a date beside the figure is not a second figure");
});

test("an amount printed as words is nil in words, never a zero; a comparative beside it is dropped", () => {
  const a = readAmount("undrawn at the year end (2024: £nil)");
  assertEqual(a.kind, "nil", "undrawn");
  assertEqual(a.text, "undrawn at the year end", "the comparative is not part of the words");
  assertEqual(readAmount("–").kind, "nil", "a printed dash");
});

test("words that carry two figures establish neither (James Fisher, recorded)", () => {
  const a = readAmount("the Group had drawn down £51.0m under the RCF, leaving £21.5m undrawn and available");
  assertEqual(a.kind, "several", "two figures");
  assertEqual(readAmount("£75.0m (RCF reducing to £72.5m from £75.0m)").kind, "several", "three figures");
});

test("maturities and rates agree on their dates and percentages, not their wording", () => {
  assertEqual(maturitySignature("November 2029").join(), maturitySignature("maturing in November 2029").join(), "same month");
  assert(maturitySignature("November 2029").join() !== maturitySignature("November 2028").join(), "a different year");
  assertEqual(maturitySignature("committed for three years from 18 May 2025").join(), "2025-05-18,3-year", "a term and a date");
  assertEqual(rateSignature("9.375% per annum").join(), "9.375%", "a rate");
  assertEqual(rateSignature("3.0% above compounded SONIA").join(), "3%,sonia", "a margin and its reference rate");
});

test("security and ranking words agree only when they say the same thing", () => {
  assertEqual(phraseProblem("senior secured", "senior secured bond"), null, "a harmless extra word");
  assert(phraseProblem("senior secured", "super senior secured") !== null, "super senior is not senior");
  assert(phraseProblem("secured", "unsecured") !== null, "unsecured is not secured");
  assert(statesRanking("super senior") && statesRanking("ranks pari passu with") && !statesRanking("fixed and floating charge"), "ranking words");
});

suite("capitalStructure / the second read is independent");

test("Boparan: only the debt-note pages (90 and 91) are sent, with none of the first read's facility words", async () => {
  const { read, requests } = await tableFor(BOPARAN);
  assertEqual(requests.length, 1, "one facility read");
  const body = requests[0];
  const doc = (body.messages[0].content as any[]).find((b) => b.type === "document");
  const sent = new Uint8Array(Buffer.from(doc.source.data, "base64"));
  // The re-recorded first read cites notes 19 and 20 (PDF page 90) and note 21 (PDF page 91).
  assertEqual(debtNotePages(read).join(), "90,91", "the note is on PDF pages 90 and 91");
  assertEqual(await pdfPageCount(sent), 2, "two pages sent, of 113");
  assert(await carriesPages(sent, pdf(BOPARAN), [90, 91]), "exactly pages 90 and 91, their images byte for byte the filing's");
  assert(JSON.stringify(body.output_config.format.schema) === JSON.stringify(FACILITY_READ_SCHEMA), "the facility schema");
  assertEqual(body.output_config.effort, FACILITY_READ_EFFORT, "at capped effort");
  const words = JSON.stringify({ system: body.system, text: (body.messages[0].content as any[]).filter((b) => b.type === "text") });
  if (read.debtNote.status !== "found") throw new Error("no debt note");
  for (const f of read.debtNote.facilities) {
    for (const v of [f.nameAsPrinted, f.amountDrawnText, f.facilitySizeText, f.maturity, f.rateOrMargin, f.security]) {
      if (v && v.length > 3) assert(!words.includes(v), `"${v}" is not in the request`);
    }
  }
});

suite("capitalStructure / Boparan, recorded (gold, Claude-checked only)");

test("both facilities surface, cited to page 91 of the group's note 21, with no fulcrum", async () => {
  const { table } = await tableFor(BOPARAN);
  assertEqual(table.status, "found", "found");
  // Copied by the re-recorded facility read with the spacing it saw on the page.
  assertEqual(table.noteHeading, "21.    BORROWINGS", "the note as printed");
  assertEqual(table.fulcrumStated, false, "no fulcrum");
  const bond = rowNamed(table, /bond/i)!;
  assertEqual(bond.status, "found", "the bond surfaces");
  assertEqual(bond.cells.committed.pounds, 390_000_000, "£390.0m");
  assertEqual(bond.cells.drawn.pounds, 390_000_000, "390.0 under £m");
  assertEqual(bond.cells.rateOrMargin.text, "9.375% per annum", "the coupon as printed");
  assertEqual(bond.page, 91, "page 91");
  const rcf = rcfOf(table)!;
  assertEqual(rcf.status, "found", "the RCF surfaces");
  assertEqual(rcf.cells.committed.pounds, 80_000_000, "£80.0m");
  assertEqual(rcf.cells.drawn.nil, true, "undrawn (the first read copied the dash, the second \"undrawn\")");
  assertEqual(rcf.cells.drawn.pounds, null, "never turned into a zero");
  assertEqual(rcf.page, 91, "page 91");
  assert(rcf.citation.includes("group accounts"), "the citation says the note is the group's");
  // The re-recorded first read also lists two lines of the note's table that the second read did
  // not list as facilities; each abstains, and neither is shown.
  const extra = table.rows.filter((r) => r !== bond && r !== rcf);
  assertEqual(extra.map((r) => r.name).join(" | "), "Bond notes at amortised cost (note 23) | Total other borrowings (note 23)", "the lines only the first read listed");
  assert(extra.every((r) => r.status === "abstain" && /second read did not list/.test(r.reason ?? "")), "abstain, seen by one read only");
});

test("the note's ranking words are shown only where both reads copied the same ones", async () => {
  const { table } = await tableFor(BOPARAN);
  // The re-recorded second read copied no ranking words for either facility, so the first read's
  // ("Senior Loan Notes", "super senior") are seen by one read only.
  const bond = rowNamed(table, /bond/i)!;
  assertEqual(bond.cells.ranking.status, "abstain", "\"Senior Loan Notes\", read once, is not shown");
  assert(/Only one read found words on ranking \("Senior Loan Notes"\)/.test(bond.cells.ranking.reason ?? ""), bond.cells.ranking.reason ?? "");
  const rcf = rcfOf(table)!;
  assertEqual(rcf.cells.ranking.status, "abstain", "\"super senior\", read once, is not shown");
  assert(/Only one read found words on ranking \("super senior"\)/.test(rcf.cells.ranking.reason ?? ""), rcf.cells.ranking.reason ?? "");
  // Both reads copying the same words is what shows them: the second read given the first's.
  const same = await tableFor(BOPARAN, { mutate: (a) => (a.facilities[1].ranking_text = "super senior") });
  assertEqual(rcfOf(same.table)!.cells.ranking.status, "agreed", "the same words from both reads are shown");
  // Rows keep the note's order; nothing sorts them senior to junior.
  assertEqual(table.rows.map((r) => r.id).join(), "facility-1,facility-2,facility-3,facility-4", "printed order");
});

test("the lease line in the note is left to lease liabilities, and said so", async () => {
  const { table } = await tableFor(BOPARAN);
  assert(!table.rows.some((r) => r.type === "lease"), "no lease row");
  assert(table.notes.some((n) => /lease/.test(n)), "a note says why");
});

suite("capitalStructure / what abstains, on real answers changed one field at a time");

test("a disagreement on the committed size abstains that cell and names both figures", async () => {
  // On the re-recorded reads the bond pairs across the two reads on its name, type and amount drawn,
  // so its committed size can be changed alone.
  const { table } = await tableFor(BOPARAN, { mutate: (a) => (a.facilities[0].facility_size_text = "£395.0m") });
  const bond = rowNamed(table, /^bond notes$/i)!;
  assertEqual(bond.cells.committed.status, "abstain", "abstains");
  assert(/£390,000,000.*£395,000,000/.test(bond.cells.committed.reason ?? ""), `names both: ${bond.cells.committed.reason}`);
  assertEqual(bond.cells.maturity.status, "agreed", "the other cells stand");
  // The RCF is named "Other borrowings" by the first read and "Revolving Credit Facility (RCF)" by
  // the second, so it pairs on its committed size and type alone. A different size there leaves the
  // two reads unpaired, and the whole row abstains rather than showing either figure.
  const rcfTable = (await tableFor(BOPARAN, { mutate: (a) => (a.facilities[1].facility_size_text = "£85.0m") })).table;
  const rcf = rcfOf(rcfTable)!;
  assertEqual(rcf.status, "abstain", "the RCF row abstains");
  assertEqual(rcf.cells.committed.status, "abstain", "its committed size is not shown");
});

test("an amount drawn read from a comparative column abstains", async () => {
  const { table } = await tableFor(BOPARAN, { mutate: (a) => (a.facilities[0].drawn_column_heading = "2024") });
  const bond = rowNamed(table, /bond/i)!;
  assertEqual(bond.cells.drawn.status, "abstain", "abstains");
  assert(/period did not match/.test(bond.cells.drawn.reason ?? ""), bond.cells.drawn.reason ?? "");
});

test("an amount in another currency abstains; the sheet is in pounds", async () => {
  const { table } = await tableFor(BOPARAN, {
    mutate: (a) => (a.facilities[1].facility_size_text = "US$80.0m"),
    read: await (async () => {
      const r = JSON.parse(JSON.stringify(await firstRead(BOPARAN))) as VisionReadResult;
      if (r.debtNote.status === "found") r.debtNote.facilities.find((f) => f.type === "revolving_credit_facility")!.facilitySizeText = "US$80.0m";
      return r;
    })(),
  });
  const rcf = rcfOf(table)!;
  assertEqual(rcf.cells.committed.status, "abstain", "abstains");
  assert(/USD/.test(rcf.cells.committed.reason ?? ""), rcf.cells.committed.reason ?? "");
});

test("a bare figure with no caption printed at the head of the note abstains on scale", async () => {
  const { table } = await tableFor(BOPARAN, { mutate: (a) => (a.note.header_scale_caption = "") });
  const bond = rowNamed(table, /bond/i)!;
  assertEqual(bond.cells.drawn.status, "abstain", "\"390.0\" could be pounds or millions");
  assertEqual(bond.cells.committed.status, "agreed", "\"£390.0m\" carries its own unit");
});

test("a facility the second read did not list abstains; one only the second read listed is not shown", async () => {
  const { table } = await tableFor(BOPARAN, {
    mutate: (a) => {
      a.facilities.splice(1, 1);
      a.facilities.push({ ...a.facilities[0], name_as_printed: "Vendor loan note", type: "other", amount_drawn_text: "12.0", facility_size_text: "£12.0m" });
    },
  });
  const rcf = rcfOf(table)!;
  assertEqual(rcf.status, "abstain", "the RCF abstains");
  assert(/did not list/.test(rcf.reason ?? ""), rcf.reason ?? "");
  assert(!table.rows.some((r) => /vendor/i.test(r.name ?? "")), "the second read cannot add a facility");
  assert(table.notes.some((n) => /second read listed 1 facility/.test(n)), "and it is said");
});

test("on group accounts, a company note abstains the whole table", async () => {
  const { table } = await tableFor(BOPARAN, { mutate: (a) => ((a.note.heading = "C9. Borrowings (Company)"), (a.note.basis = "company")) });
  assertEqual(table.status, "abstain", "abstains");
  assertEqual(table.rows.length, 0, "no row");
  assert(/company-only statement in a group filing/.test(table.reason ?? ""), table.reason ?? "");
});

test("on group accounts, a note with no group wording abstains; on company accounts the check does not run", async () => {
  const strip = (a: FacilityReadWire) => ((a.note.basis_text = "Notes to the financial statements"), (a.note.basis = "consolidated"));
  const group = await tableFor(BOPARAN, { mutate: strip });
  assertEqual(group.table.status, "abstain", "group: abstains");
  // WP-GRPCHK: Boparan's first read took the consolidated statements, so lodged as "full" it is
  // still a group's filing and the check still runs.
  const full = await tableFor(BOPARAN, { mutate: strip, accountsType: "full" });
  assertEqual(full.table.status, "abstain", "a group's filing lodged as full accounts: the check runs");
  assert(full.table.reason!.includes('the register calls it "full" accounts'), full.table.reason ?? "");
  // A first read of a company's own statements, with no group statement cited, is not held to it.
  const base = await firstRead(BOPARAN);
  const lines = Object.fromEntries(
    Object.entries(base.lines).map(([k, l]) => [k, l.status === "found" ? { ...l, statement: "Balance sheet" } : l])
  ) as VisionReadResult["lines"];
  const companyRead: VisionReadResult = { ...base, document: { ...base.document, basis: "company" }, lines };
  const company = await tableFor(BOPARAN, { mutate: strip, accountsType: "full", read: companyRead });
  assertEqual(company.table.status, "found", "company accounts: the check does not apply");
});

test("the reads disagreeing on the basis abstains", async () => {
  const { table } = await tableFor(BOPARAN, { mutate: (a) => (a.note.basis = "none") });
  assertEqual(table.status, "abstain", "abstains");
  assert(/did not agree on the basis/.test(table.reason ?? ""), table.reason ?? "");
});

suite("capitalStructure / nothing is bought by accident");

class CountingProvider implements StructuredLLMProvider {
  readonly name = "count";
  readonly model = "claude-opus-5";
  calls = 0;
  constructor(private readonly answer: LLMCallResult) {}
  async complete(): Promise<string> {
    throw new Error("not used");
  }
  async send(_req: LLMRequest): Promise<LLMCallResult> {
    this.calls++;
    return this.answer;
  }
}

test("cache-only with nothing cached makes no call and abstains; a cached read makes none either", async () => {
  const read = await firstRead(BOPARAN);
  const p = new CountingProvider({ ok: true, text: JSON.stringify(answerOf(recordedFacilityResponse(BOPARAN.number))), stopReason: "end_turn", usage: null as never });
  const cache = new InMemoryCache();
  const cold = await new DebtNoteFacilityReader({ provider: p, cache, cacheOnly: true }).read({ read, pdfBytes: pdf(BOPARAN), accountsType: "group" });
  assertEqual(p.calls, 0, "no call");
  assertEqual(cold.table.status, "abstain", "abstains");
  await new DebtNoteFacilityReader({ provider: p, cache }).read({ read, pdfBytes: pdf(BOPARAN), accountsType: "group" });
  assertEqual(p.calls, 1, "one paid read");
  const warm = await new DebtNoteFacilityReader({ provider: p, cache, cacheOnly: true }).read({ read, pdfBytes: pdf(BOPARAN), accountsType: "group" });
  assertEqual(p.calls, 1, "the cached read made no call");
  assertEqual(warm.table.status, "found", "and it is served");
});

test("a failed call, or an answer in the wrong shape, abstains the table and confirms nothing", async () => {
  const read = await firstRead(BOPARAN);
  const failed = new CountingProvider({ ok: false, failure: { kind: "http", detail: "HTTP 400" }, usage: null } as never);
  const a = await new DebtNoteFacilityReader({ provider: failed, cache: new InMemoryCache() }).read({ read, pdfBytes: pdf(BOPARAN) });
  assertEqual(a.table.status, "abstain", "a failed call abstains");
  const junk = new CountingProvider({ ok: true, text: "{\"facilities\": 3}", stopReason: "end_turn", usage: null as never });
  const b = await new DebtNoteFacilityReader({ provider: junk, cache: new InMemoryCache() }).read({ read, pdfBytes: pdf(BOPARAN) });
  assertEqual(b.table.status, "abstain", "a malformed answer abstains");
});

test("a first read with no debt note makes no facility call", async () => {
  const read = JSON.parse(JSON.stringify(await firstRead(BOPARAN))) as VisionReadResult;
  read.debtNote = { status: "abstain", reason: "no-facilities-read" };
  const p = new CountingProvider({ ok: true, text: "{}", stopReason: "end_turn", usage: null as never });
  const r = await new DebtNoteFacilityReader({ provider: p, cache: new InMemoryCache() }).read({ read, pdfBytes: pdf(BOPARAN) });
  assertEqual(p.calls, 0, "no call");
  assert(/No debt note was read/.test(r.table.reason ?? ""), r.table.reason ?? "");
});

suite("capitalStructure / the debt-note gold (provisional: Claude-checked only)");

test("no agreed cell contradicts any of the four gold facilities", async () => {
  const verdicts = await goldFacilityVerdicts();
  assertEqual(verdicts.length, 4, "four gold facilities");
  const wrong = verdicts.flatMap((v) => v.contradictions.map((c) => `${v.company} ${v.gold}: ${c}`));
  assertEqual(wrong.length, 0, wrong.join("; "));
});

test("Boparan's bond and RCF surface with the gold committed amounts; Solid State abstains with its reason", async () => {
  const verdicts = await goldFacilityVerdicts();
  const bop = verdicts.filter((v) => v.company.startsWith("BOPARAN"));
  assert(bop.every((v) => v.outcome === "surfaced" && v.agreed.includes("committed")), bop.map((v) => `${v.gold}: ${v.outcome}`).join("; "));
  const ss = verdicts.filter((v) => v.company.startsWith("SOLID"));
  assert(ss.every((v) => v.outcome === "table-abstained"), ss.map((v) => v.outcome).join());
  const { table } = await tableFor(SOLID_STATE);
  // No heading on the note's page says whose note it is, so the reads cannot agree it is the group's.
  assert(/did not agree on the basis.*"19\. Bank borrowings and facilities"/.test(table.reason ?? ""), table.reason ?? "");
});

suite("capitalStructure / the large group scans, recorded");

for (const c of LARGE_FILINGS) {
  const path = join(FX, "facilities", `${c.number}.json`);
  if (!existsSync(path)) continue;
  test(`${c.name}: beside the second read, the facility read keeps the filing under 90 seconds`, () => {
    const rec = loadJson(path);
    assert(rec.seconds.composedTotal < 90, `${rec.seconds.composedTotal}s`);
    assert(rec.seconds.facilityRead <= rec.seconds.recordedSecondRead, `the facility read (${rec.seconds.facilityRead}s) is not the slower of the two`);
  });
}

test("Solid State, measured end to end with both second reads side by side, is under 90 seconds", () => {
  const rec = facilityRecording(SOLID_STATE.number);
  assert(rec.seconds.total < 90, `${rec.seconds.total}s`);
});

// James Fisher's note 25 prints its RCF in sentences with more than one figure. The WP-BE16 reads
// (22 Sep 2026) listed it; the WP-BE14-LIVE-2 re-recording did not. Its page-finding sent only note
// 25's continuation page (PDF page 171), the first read listed that page's debt and lease lines,
// and the facility read listed no facility and could not tell whose note it is, so the recorded
// table abstains with no row. The two facilities are put into both recorded answers with the words
// the WP-BE16 reads copied from the note, and the facility read is given the group's basis, so the
// two-figure rule runs on the note's own words. Everything else is the recording.
const JF_RCF = {
  name: "Revolving credit facility",
  drawn: "the Group had drawn down £51.0m under the RCF, leaving £21.5m undrawn and available",
  size: "£75.0m (RCF reducing to £72.5m from £75.0m)",
};
const JF_TCL = { name: "Trade cycle loan", size: "£7.0m" };

test("James Fisher: amounts in sentences with two figures abstain; single figures surface", async () => {
  const jf = LARGE_FILINGS.find((x) => x.number === "00211475")!;
  const recorded = await tableFor({ ...jf });
  assertEqual(recorded.table.status, "abstain", "as recorded, the facility read lists nothing and the table abstains");
  assertEqual(recorded.table.rows.length, 0, "with no row");
  const base = JSON.parse(JSON.stringify(await firstRead({ ...jf }))) as VisionReadResult;
  if (base.debtNote.status !== "found") throw new Error("the recorded first read has no debt note");
  const page = base.debtNote.pdfPageIndexes[0];
  const blank = { lender: null, amountDrawnValue: null, facilitySizeValue: null, currency: "GBP", maturity: null, rateOrMargin: null, security: null, ranking: null, pdfPageIndex: page };
  base.debtNote.facilities.push(
    { ...blank, nameAsPrinted: JF_RCF.name, type: "revolving_credit_facility", amountDrawnText: JF_RCF.drawn, facilitySizeText: JF_RCF.size },
    { ...blank, nameAsPrinted: JF_TCL.name, type: "other", amountDrawnText: null, facilitySizeText: JF_TCL.size }
  );
  const wire = { lender: "", drawn_column_heading: "", drawn_period_end: jf.madeUpDate, maturity: "", rate_or_margin: "", security: "", ranking_text: "", excerpt_page: 1 };
  const { table } = await tableFor({ ...jf }, {
    read: base,
    mutate: (a) => {
      Object.assign(a.note, { basis: "consolidated", basis_text: "Group" });
      a.facilities.push(
        { ...wire, name_as_printed: JF_RCF.name, type: "revolving_credit_facility", amount_drawn_text: JF_RCF.drawn, facility_size_text: JF_RCF.size },
        { ...wire, name_as_printed: JF_TCL.name, type: "other", amount_drawn_text: "", facility_size_text: JF_TCL.size }
      );
    },
  });
  assertEqual(table.status, "found", table.reason ?? "found");
  const rcf = rowNamed(table, /revolving/i)!;
  assertEqual(rcf.cells.drawn.status, "abstain", "\"drawn down £51.0m ... leaving £21.5m undrawn\"");
  assert(/carry more than one figure \(51\.0, 21\.5/.test(rcf.cells.drawn.reason ?? ""), rcf.cells.drawn.reason ?? "");
  assertEqual(rcf.cells.committed.status, "abstain", "\"£75.0m (reducing to £72.5m from £75.0m)\"");
  assert(/carry more than one figure \(75\.0, 72\.5, 75\.0/.test(rcf.cells.committed.reason ?? ""), rcf.cells.committed.reason ?? "");
  const tcl = rowNamed(table, /trade cycle/i)!;
  assertEqual(tcl.cells.committed.pounds, 7_000_000, "£7.0m");
  assert(table.rows.every((r) => r.cells.ranking.status !== "agreed"), "the note states no ranking, and none is shown");
});

test("Tesco: the page-found excerpt has no borrowings note, so the table abstains and no call is made", async () => {
  const t = LARGE_FILINGS.find((x) => x.number === "00445790")!;
  const read = await firstRead({ ...t });
  const p = new CountingProvider({ ok: true, text: "{}", stopReason: "end_turn", usage: null as never });
  const r = await new DebtNoteFacilityReader({ provider: p, cache: new InMemoryCache() }).read({ read, pdfBytes: pdf(t), accountsType: "group" });
  assertEqual(p.calls, 0, "no call");
  assertEqual(r.table.status, "abstain", "abstains");
});

suite("capitalStructure / registered charges are charges, with no rank and no fulcrum (audit finding 7)");

const PROFILE: CompanyProfile = {
  company_name: "EXAMPLE HOLDINGS LIMITED",
  company_number: "01234567",
  company_status: "active",
  date_of_creation: "2001-01-01",
  type: "ltd",
  jurisdiction: "england-wales",
  sic_codes: ["70100"],
  registered_office_address: { address_line_1: "1 Street", locality: "London", country: "England" },
  accounts: { accounting_reference_date: { day: "31", month: "12" }, last_accounts: { made_up_to: "2025-12-31", type: "group" }, next_due: "2026-09-30" },
};
const CHARGES: ChargesList = {
  total_count: 2,
  unfiled_count: 0,
  items: [
    { charge_number: 2, status: "outstanding", created_on: "2024-11-07", classification: { type: "charge-description", description: "A registered charge" }, persons_entitled: [{ name: "Security Trustee Limited" }], secured_details: { description: "Fixed and floating charge" } },
    { charge_number: 1, status: "satisfied", created_on: "2019-05-01", classification: { type: "charge-description", description: "A registered charge" }, persons_entitled: [{ name: "Old Bank PLC" }] },
  ] as never,
};

test("the live fixture claims no rank and no fulcrum for any charge", () => {
  const manifest = mapLiveToManifest(PROFILE, CHARGES);
  const fixture = mapLiveToFixture(PROFILE, CHARGES, manifest);
  assertEqual(fixture.capitalStructure.length, 2, "one tranche per charge");
  assert(fixture.capitalStructure.every((t) => t.rank === "not-stated" && t.isFulcrum === false), "no rank, no fulcrum");
  const ts = assembleTearSheet(manifest, fixture);
  assert(ts.capital.every((c) => !c.isFulcrum && c.rank === "ranking not stated"), "the sheet says the ranking is not stated");
  assertEqual(ts.facilities, null, "no debt note read, no facilities table");
});

test("a reopened sheet claims no more than its first view, and carries its facilities table", async () => {
  const { table } = await tableFor(BOPARAN);
  const manifest = mapLiveToManifest(PROFILE, CHARGES, { capitalStructure: table });
  assertEqual(manifest.capitalStructure?.status, "found", "the manifest carries the table");
  const reopened = fixtureFromManifest(manifest);
  assert(reopened.capitalStructure.every((t) => t.rank === "not-stated" && !t.isFulcrum), "no rank, no fulcrum on reopening");
  const ts = assembleTearSheet(manifest, reopened);
  // Boparan's re-recorded table has four rows: the bond and the RCF, seen by both reads, and two
  // lines only the first read listed, which abstain.
  assertEqual(ts.facilities?.rows.length, 4, "the facilities table survives the round trip");
  assertEqual(ts.facilities?.rows.map((r) => `${r.id}:${r.status}`).join(), table.rows.map((r) => `${r.id}:${r.status}`).join(), "row for row, abstentions included");
  assertEqual(ts.facilities?.rows.filter((r) => r.status === "found").length, 2, "the bond and the RCF still surface");
  assert(!!manifest.sources["ch-live-accounts-vision"], "the scanned filing is a source of the sheet");
});
