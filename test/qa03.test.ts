// test/qa03.test.ts
// WP-QA03, bug hunt round 1 (code and API lens, no browser). Each case here was a failing test
// before its fix; the finding it proves is named in the suite line and ranked in
// docs/programme/reports/WP-QA03.md. No network and no model: the builder and the resolver are
// stubs, and the route handlers called directly are the ones that need no request context.

import { suite, test, assert, assertEqual } from "./harness";
import { InMemoryRunStore } from "../lib/run/store";
import { runToCompletion } from "../lib/run/runner";
import type { StageEvent } from "../lib/vision/types";
import type { FactManifest } from "../lib/engine/types";
import type { ChFilingItem, ChProfile, ChSearchResult, ResolveClient } from "../lib/resolve/types";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { POST as login } from "../app/api/auth/login/route";
import { POST as register } from "../app/api/auth/register/route";
import { POST as kbIngest } from "../app/api/kb/ingest/route";
import { resetRateLimiterForTests } from "../lib/ratelimit/ratelimit";
import { getAuthStore, resetAuthStoreForTests } from "../lib/auth/store";
import { hashPassword } from "../lib/auth/crypto";
import { clientIp } from "../lib/ratelimit/ratelimit";
import { readJsonObject, textField } from "../lib/http/body";
import { LIMITS, throttle } from "../lib/http/limit";
import { profileFromWire } from "../lib/onboarding/profile";
import { runTurn } from "../lib/onboarding/agent";
import { extractFinancialsFromText, detectScale } from "../lib/sources/pdfAccounts";
import { buildManifest } from "../lib/engine/buildManifest";
import { computeDelta, assembleTearSheet } from "../lib/engine/assemble";
import { resolveMetric, leverageResolver, ebitdaResolver, netDebtResolver } from "../lib/engine/ladder";
import { meridian } from "../lib/sources/fixtures/meridian";
import { tearSheetForKey } from "../lib/engine/pipeline";
import { assembleModelWorkbook } from "../lib/model/buildWorkbook";
import { parseIxbrl } from "../lib/sources/ixbrl";
import { formatValue } from "../lib/format/format";
import type { Fact } from "../lib/engine/types";
import { valueGroundedInQuote } from "../lib/llm/extract";
import { InMemorySharedLearningStore } from "../lib/clientspec/sharedStore";
import { visibleCandidates, DEFAULT_K } from "../lib/clientspec/promote";
import { InMemoryMonitorStore } from "../lib/monitor/store";
import type { Snapshot } from "../lib/monitor/types";
import { screenUniverse } from "../lib/originate/screenUniverse";
import { InMemoryGraphStore } from "../lib/graph/store";
import { getLatestAccountsIxbrl, mapLiveToManifest, textLayerExtraction } from "../lib/sources/companiesHouseLive";
import { getCache, resetCacheForTests } from "../lib/cache/cache";

const TENANT = "qa03";
const NUMBER = "02662226";

// A register that knows exactly one company, so the resolver hands the builder a number.
class OneCompanyClient implements ResolveClient {
  private readonly profileRow: ChProfile = {
    company_name: "BRISTOL WATER PLC",
    company_number: NUMBER,
    company_status: "active",
    type: "plc",
    jurisdiction: "england-wales",
    accounts: { last_accounts: { made_up_to: "2026-03-31", type: "group" } },
  };
  async search(): Promise<ChSearchResult> {
    return {
      items: [
        {
          company_number: NUMBER,
          title: "BRISTOL WATER PLC",
          company_status: "active",
          company_type: "plc",
          date_of_creation: "1991-10-18",
          address: { locality: "Bristol" },
        },
      ],
      total_results: 1,
    };
  }
  async profile(number: string): Promise<ChProfile | null> {
    return number === NUMBER ? this.profileRow : null;
  }
  async filingHistory(): Promise<ChFilingItem[]> {
    return [];
  }
  async leiForCompanyNumber(): Promise<string | null> {
    return null;
  }
}

const HERE = dirname(fileURLToPath(import.meta.url));
const post = (url: string, body: string, ip = "203.0.113.7") =>
  new Request(url, { method: "POST", body, headers: { "content-type": "application/json", "x-real-ip": ip } });

// Call a handler and report what came back, or that it threw (which Next turns into a bare 500).
async function statusOf(p: Promise<Response>): Promise<number | string> {
  try {
    return (await p).status;
  } catch (e) {
    return `threw: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...routeFiles(full));
    else if (name === "route.ts") out.push(full);
  }
  return out;
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

export async function registerQa03Tests(): Promise<void> {
  // -------------------------------------------------------------------------------------------
  // F1. A timed-out run's record is rewritten by the builder it abandoned.
  // The watchdog stops WAITING for the builder but cannot cancel it. The builder keeps its
  // onStage callback, and every late event went through the ledger, which mutated the stage
  // rows and queued another save. So a run the poller had been told was over (partial, fetch
  // timed out) came back later with fetch "done" and extract "running", and view.currentStage
  // stayed null because the status was terminal: a finished run showing live work.
  // -------------------------------------------------------------------------------------------
  const store = new InMemoryRunStore();
  let late: ((e: StageEvent) => void) | undefined;
  const finished = await runToCompletion(TENANT, "Bristol Water", {
    store,
    resolveClient: new OneCompanyClient(),
    budget: { totalMs: 60_000, stageMs: { resolve: 20_000, fetch: 30, extract: 30, verify: 30, assemble: 30 } },
    persist: async () => {},
    build: async (_n, options) => {
      late = options.onStage;
      options.onStage?.({ stage: "fetch", status: "start", detail: "PDF accounts", at: new Date().toISOString() });
      return new Promise<FactManifest>(() => {}); // hangs, as a stuck document fetch does
    },
  });
  // The abandoned builder wakes up and carries on reporting.
  const at = new Date().toISOString();
  late?.({ stage: "fetch", status: "done", detail: "PDF fetched after all", at });
  late?.({ stage: "extract", status: "start", detail: "Reading the scan", at });
  await tick(20);
  const reread = await store.load(TENANT, finished.id);

  suite("QA03 F1 / a timed-out run stays as it was left");
  test("the terminal record is the one the poller was told about", () => {
    assertEqual(finished.status, "partial", "precondition: the run timed out");
    assert(reread !== null, "the run is readable");
    const fetch = reread!.stages.find((s) => s.stage === "fetch")!;
    const extract = reread!.stages.find((s) => s.stage === "extract")!;
    assertEqual(fetch.status, "timed-out", "the stage that timed out is not flipped to done by a late event");
    assertEqual(extract.status, "pending", "a stage the run never waited for does not start after the run ended");
  });

  // -------------------------------------------------------------------------------------------
  // F2. A JSON body that parses but is not an object crashed every POST route.
  // `req.json().catch(() => ({}))` catches a body that is not JSON, not the body `null`, so
  // `body.email` threw and the route answered a bare 500. Same for `{"input": 1}` reaching
  // `.trim()`. These three handlers fail before they need a request context, so they are called
  // directly; the other thirteen share the same helper.
  // -------------------------------------------------------------------------------------------
  resetRateLimiterForTests();
  resetAuthStoreForTests();
  const nullLogin = await statusOf(login(post("http://x/api/auth/login", "null")));
  const nullRegister = await statusOf(register(post("http://x/api/auth/register", "null")));
  const nullIngest = await statusOf(kbIngest(post("http://x/api/kb/ingest", "null")));
  const arrayLogin = await statusOf(login(post("http://x/api/auth/login", "[1,2]")));
  const parsedNull = await readJsonObject(post("http://x", "null"));
  const parsedArray = await readJsonObject(post("http://x", "[]"));
  const parsedObj = await readJsonObject<{ a: number }>(post("http://x", '{"a":1}'));

  suite("QA03 F2 / a body that is JSON but not an object is a 400, not a crash");
  test("login, register and kb ingest answer 400 to the body null", () => {
    assertEqual(nullLogin, 400, "login");
    assertEqual(nullRegister, 400, "register");
    assertEqual(nullIngest, 400, "kb ingest");
    assertEqual(arrayLogin, 400, "login with an array body");
  });
  test("readJsonObject gives an empty object for null and arrays, and the object otherwise", () => {
    assertEqual(JSON.stringify(parsedNull), "{}", "null");
    assertEqual(JSON.stringify(parsedArray), "{}", "array");
    assertEqual(parsedObj.a, 1, "a real object passes through");
  });
  test("textField reads only strings", () => {
    assertEqual(textField("Tesco"), "Tesco", "a string");
    assertEqual(textField(123), "", "a number is not a name");
    assertEqual(textField(["a"]), "", "an array is not a name");
    assertEqual(textField(undefined), "", "absent");
  });
  test("no route reads a string body field with a bare `?? \"\").trim()`", () => {
    const offenders: string[] = [];
    for (const f of routeFiles(join(HERE, "..", "app", "api"))) {
      const src = readFileSync(f, "utf8");
      if (/req\.json\(\)\.catch\(\(\) => \(\{\}\)\)/.test(src)) offenders.push(`${f}: raw req.json()`);
      if (/(?<!String)\(body\.\w+ \?\? ""\)\.trim\(\)/.test(src)) offenders.push(`${f}: (body.x ?? "").trim()`);
    }
    assertEqual(offenders.join("\n"), "", "every route goes through lib/http/body.ts");
  });

  // -------------------------------------------------------------------------------------------
  // F3. Login and register had no throttle, and POST /api/run had none either.
  // Unlimited password guesses (each a synchronous scrypt), unlimited accounts, and unlimited
  // runs, each able to reach a paid scan read. /api/run needs a request context, so its limit is
  // proven through the same throttle() it calls.
  // -------------------------------------------------------------------------------------------
  resetRateLimiterForTests();
  resetAuthStoreForTests();
  const loginStatuses: (number | string)[] = [];
  for (let i = 0; i < 30; i++) {
    loginStatuses.push(
      await statusOf(login(post("http://x/api/auth/login", JSON.stringify({ email: "victim@example.com", password: `guess-${i}-xx` })))),
    );
  }
  resetRateLimiterForTests();
  const registerStatuses: (number | string)[] = [];
  for (let i = 0; i < 15; i++) {
    registerStatuses.push(
      await statusOf(register(post("http://x/api/auth/register", JSON.stringify({ email: `bot${i}@example.com`, password: "long enough pw" })))),
    );
  }
  resetRateLimiterForTests();
  const runAnswers: (Response | null)[] = [];
  for (let i = 0; i < LIMITS.runPerTenant.limit + 1; i++) {
    runAnswers.push(await throttle([{ bucket: "run:tenant", id: "desk-1", ...LIMITS.runPerTenant }]));
  }
  const otherDesk = await throttle([{ bucket: "run:tenant", id: "desk-2", ...LIMITS.runPerTenant }]);
  resetRateLimiterForTests();

  suite("QA03 F3 / the routes that cost something are throttled");
  test("password guessing against one account meets a 429", () => {
    assert(loginStatuses.includes(429), `statuses: ${loginStatuses.join(",")}`);
    assertEqual(loginStatuses[0], 401, "the first wrong guess is still a plain 401");
    assert(loginStatuses.slice(0, LIMITS.loginPerEmail.limit).every((s) => s === 401), "a person mistyping is not blocked");
  });
  test("mass registration from one address meets a 429", () => {
    assert(registerStatuses.includes(429), `statuses: ${registerStatuses.join(",")}`);
  });
  test("a desk that starts too many runs is told to wait, and another desk is not", async () => {
    assert(runAnswers.slice(0, LIMITS.runPerTenant.limit).every((r) => r === null), "within the limit, go ahead");
    const last = runAnswers[runAnswers.length - 1];
    assert(last !== null, "past the limit, an answer");
    assertEqual(last!.status, 429, "429");
    assert(Number(last!.headers.get("retry-after")) > 0, "with a Retry-After");
    assertEqual(otherDesk, null, "the limit is per desk");
  });

  // -------------------------------------------------------------------------------------------
  // F4. 500 answers carried the raw exception text to the caller.
  // /api/originate, /api/resolve and /api/pipeline returned `(e as Error).message`: a driver
  // error, a register URL or a TypeError such as "(body.keepId ?? \"\").trim is not a function".
  // -------------------------------------------------------------------------------------------
  suite("QA03 F4 / a 500 does not read the exception out to the caller");
  test("no route serialises an exception message into its JSON", () => {
    const offenders = routeFiles(join(HERE, "..", "app", "api")).filter((f) =>
      /error:\s*\(e as Error\)\.message/.test(readFileSync(f, "utf8")),
    );
    assertEqual(offenders.join(", "), "", "routes that leak e.message");
  });

  // -------------------------------------------------------------------------------------------
  // F5. /api/onboarding trusted the profile the browser sent back.
  // The conversation is stateless, so the whole profile round-trips; `{"profile":{"firmName":"x"}}`
  // has no mandate, and the first slot check read `profile.mandate.sectors` and threw.
  // -------------------------------------------------------------------------------------------
  let partialTurn: string = "not run";
  try {
    const r = await runTurn(profileFromWire({ firmName: "x" }), "infrastructure and healthcare", null, { tenantId: "qa03-onb" });
    partialTurn = r.nextQuestion ? "answered" : "no question";
  } catch (e) {
    partialTurn = `threw: ${(e as Error).message}`;
  }
  const junk = profileFromWire({ mandate: { sectors: "tech", maxLeverage: "6x" }, relationships: "all", constraints: [1, "no tobacco"] });

  suite("QA03 F5 / a partial or malformed onboarding profile does not crash the turn");
  test("a profile with no mandate still gets its next question", () => {
    assertEqual(partialTurn, "answered", "the turn");
  });
  test("wrong-typed fields are dropped, not passed on", () => {
    assertEqual(junk.mandate.sectors, undefined, "a string is not a sector list");
    assertEqual(junk.mandate.maxLeverage, undefined, "\"6x\" is not a number");
    assertEqual(junk.relationships.length, 0, "relationships must be a list");
    assertEqual(JSON.stringify(junk.constraints), JSON.stringify(["no tobacco"]), "only text constraints survive");
  });

  // ===========================================================================================
  // Numbers. Each of these put a figure on the sheet or in the workbook that the filing never
  // printed, or printed with the opposite sign.
  // ===========================================================================================

  // N1. A dash printed for nil dropped out of the PDF text reader's token list, so the next
  // column moved up: the prior year read as the current year, or the note number as the figure.
  const PAD = "\nThese notes form part of the financial statements and are padding for the reader.\n";
  const pdfLine = (row: string) => extractFinancialsFromText(`Figures in £'000\n${row}${PAD}`);
  const lineValue = (row: string, metric: string) =>
    pdfLine(row)?.lines.find((l) => l.metric === metric)?.value ?? null;
  const nilCurrentPriorPrinted = lineValue("Bank loans and borrowings 14 – 250", "borrowings");
  const nilBoth = lineValue("Bank loans and borrowings 14 – –", "borrowings");
  const nilNoNote = lineValue("Bank loans and borrowings - 250", "borrowings");
  const ordinary = lineValue("Bank loans and borrowings 14 1,234 1,100", "borrowings");
  const minus = lineValue("Operating profit -1,234 2,000", "operatingProfit");
  const bracketInterest = lineValue("Interest payable 7 (1,234) (1,100)", "netInterest");
  const statutoryInterest = lineValue("Interest payable and similar expenses 7 1,234 1,100", "netInterest");

  suite("QA03 N1 / a dash for nil in the PDF text layer is not skipped over");
  test("a nil current year does not read the prior year", () => {
    assertEqual(nilCurrentPriorPrinted, null, "note 14, nil, prior 250: no figure, not 250,000");
    assertEqual(nilNoNote, null, "nil, prior 250: no figure, not 250,000");
  });
  test("a row of nils does not read the note number", () => {
    assertEqual(nilBoth, null, "note 14, nil, nil: no figure, not 14,000");
  });
  test("an ordinary row still reads its current year", () => {
    assertEqual(ordinary, 1_234_000, "note 14, 1,234, 1,100");
  });
  test("a printed minus sign is kept", () => {
    assertEqual(minus, -1_234_000, "operating loss -1,234");
  });

  // N2. Interest payable printed in brackets came through negative from the text layer (the scan
  // path takes the magnitude by line nature; this path did not), so a healthy company showed a
  // negative interest cover on the tile and in the workbook.
  suite("QA03 N2 / an expense line printed in brackets is an expense, not a negative one");
  test("interest payable (1,234) is an expense of 1,234,000", () => {
    assertEqual(bracketInterest, 1_234_000, "interest payable");
  });
  // N9. The Companies Act format's own label, "Interest payable and similar expenses/charges",
  // never read: the regex alternation matched "payable" first and the tail then held words.
  test("the statutory label 'Interest payable and similar expenses' is read", () => {
    assertEqual(statutoryInterest, 1_234_000, "interest payable and similar expenses");
  });

  // N3. Leverage with EBITDA at or below zero printed a negative multiple ("-4x"), and net cash
  // over negative EBITDA printed a healthy-looking positive one. Neither means anything.
  const mm = buildManifest(meridian);
  const P = "FY2024";
  const base = (over: Record<string, Partial<Fact>>): Record<string, Fact> => {
    const out: Record<string, Fact> = {};
    for (const [k, v] of Object.entries(over)) {
      const seed = mm.facts[`${k}.${P}`] ?? mm.facts[`operatingProfit.${P}`];
      out[k] = { ...seed, id: `${k}.${P}`, metric: k, ...v } as Fact;
    }
    return out;
  };
  const negLev = resolveMetric(leverageResolver, {
    period: P,
    base: base({ netDebt: { value: 2_000_000 }, ebitda: { value: -500_000 } }),
  });
  const netCashNegEbitda = resolveMetric(leverageResolver, {
    period: P,
    base: base({ netDebt: { value: -2_000_000 }, ebitda: { value: -500_000 } }),
  });

  suite("QA03 N3 / leverage over EBITDA at or below zero abstains");
  test("net debt over negative EBITDA is not shown as a negative multiple", () => {
    assertEqual(negLev.value, null, `got ${negLev.value}`);
    assertEqual(negLev.rung, "R4", "abstains");
  });
  test("net cash over negative EBITDA is not shown as a healthy positive multiple", () => {
    assertEqual(netCashNegEbitda.value, null, `got ${netCashNegEbitda.value}`);
  });

  // N4. EBITDA and net debt were labelled GBP whatever the inputs were, so a USD filer's EBITDA
  // rendered under a pound sign, and mixed-currency inputs were added together.
  const usdEbitda = resolveMetric(ebitdaResolver, {
    period: P,
    base: base({ operatingProfit: { value: 6_000_000, unit: "USD" }, depreciationAmortisation: { value: 1_000_000, unit: "USD" } }),
  });
  const mixedNetDebt = resolveMetric(netDebtResolver, {
    period: P,
    base: base({ borrowings: { value: 9_000_000, unit: "USD" }, cash: { value: 1_000_000, unit: "GBP" } }),
  });

  // The workbook's Inputs sheet stamped "GBP" on every unit cell, whatever the fact said.
  const usdMm = buildManifest(meridian);
  for (const f of Object.values(usdMm.facts)) if (f.unit === "GBP") f.unit = "USD";
  const usdBook = assembleModelWorkbook(assembleTearSheet(usdMm, meridian));
  const inputs = usdBook.getWorksheet("Inputs")!;
  const unitCells: string[] = [];
  inputs.getRow(1).eachCell((c, col) => {
    if (c.value === "Unit") for (let r = 2; r <= inputs.rowCount; r++) unitCells.push(String(inputs.getCell(r, col).value ?? ""));
  });

  suite("QA03 N4 / a derived figure carries its inputs' currency");
  test("EBITDA from USD inputs is USD", () => {
    assertEqual(usdEbitda.value, 7_000_000, "value");
    assertEqual(usdEbitda.unit, "USD", "unit");
  });
  test("the workbook's Inputs sheet shows the facts' own unit", () => {
    assert(unitCells.length > 0, "found the Unit column");
    assert(!unitCells.includes("GBP"), `units: ${unitCells.join(",")}`);
  });
  test("net debt from a USD and a GBP input is not computed", () => {
    assert(mixedNetDebt.value === null || mixedNetDebt.rung === "R4", `got ${mixedNetDebt.value} ${mixedNetDebt.unit}`);
  });

  // N5. Year-on-year % divided by a negative prior kept the sign of the prior: EBITDA going from
  // -100 to +50 was "up", "+150" and "-150.0%".
  const fact = (v: number): Fact => ({ ...mm.facts[`ebitda.${P}`], value: v, unit: "GBP", rung: "R1" });
  const turnaround = computeDelta(fact(50), fact(-100), true, false);

  suite("QA03 N5 / a change from a negative prior has the sign of the change");
  test("-100 to +50 is +150.0%", () => {
    assertEqual(turnaround.direction, "up", "direction");
    assert(!turnaround.pctDisplay.includes("−") && !turnaround.pctDisplay.startsWith("-"), `pct: ${turnaround.pctDisplay}`);
  });

  // N6. The workbook's capital-structure amounts were parsed back out of the rounded display
  // ("£22.4m" -> 22,400,000), so the cell held a number no filing printed.
  // The fixture's tranches are round millions, so one is given an unround value first.
  const probe = tearSheetForKey("meridian")!;
  const tranche = probe.capital.find((c) => c.factId !== null)!;
  const mm2 = buildManifest(meridian);
  mm2.facts[tranche.factId!] = { ...mm2.facts[tranche.factId!], value: 22_437_500 };
  const sheet = assembleTearSheet(mm2, meridian);
  const row = sheet.capital.find((c) => c.factId === tranche.factId)!;
  const exact = 22_437_500;
  const wb = assembleModelWorkbook(sheet);
  const cell = wb.getWorksheet("Capital structure")!.getCell(2 + sheet.capital.indexOf(row), 5).value;

  suite("QA03 N6 / the workbook's tranche amount is the fact, not its rounded display");
  test("the amount cell holds the resolved value", () => {
    assert(typeof exact === "number", "precondition: the fixture tranche has a number");
    assertEqual(cell as number, exact as number, `display was ${row.display}`);
  });

  // N7. iXBRL format names written with hyphens (ixt4 num-comma-decimal) were read as dot-decimal:
  // "1.234" with scale 3 became 1,234 instead of 1,234,000.
  const ix = parseIxbrl(
    '<html><body><ix:nonFraction name="core:Turnover" contextRef="c" unitRef="u" scale="3" format="ixt4:num-comma-decimal">1.234</ix:nonFraction></body></html>',
  );

  suite("QA03 N7 / iXBRL comma-decimal formats with hyphens");
  test("num-comma-decimal 1.234 at scale 3 is 1,234,000", () => {
    assertEqual(ix.facts[0]?.value, 1_234_000, "value");
  });

  // N8. 999,960 rendered as "£1000k": the band was chosen before rounding.
  suite("QA03 N8 / rounding does not produce £1000k");
  test("999,960 renders as £1m", () => {
    assertEqual(formatValue(999_960, "currency", "GBP"), "£1m", "display");
  });

  // N10. The LLM text path's grounding compared digits only, so a value of 5.0 was "grounded" by
  // a quote printing 50. The path has no live caller today (extractDocumentFacts), which is why
  // it ranks low, but it is the guard the whole text path is meant to stand on.
  suite("QA03 N10 / a quote grounds a value only at the same decimal place");
  test("5.0 is not grounded by £50m, and 1.2 is not grounded by 12", () => {
    assertEqual(valueGroundedInQuote("5.0", "revenue of £50m"), false, "10x");
    assertEqual(valueGroundedInQuote("1.2", "12 facilities"), false, "10x");
  });
  test("the same figure written the same way is still grounded", () => {
    assertEqual(valueGroundedInQuote("1,234.5", "turnover 1,234.5 (2023: 1,100.0)"), true, "exact");
    assertEqual(valueGroundedInQuote("1234.5", "turnover 1,234.5"), true, "separator only");
  });

  // D1 (fixed in QA03-D1). detectScale read the WHOLE document and the thousands caption won, so
  // a £m group with a £'000 remuneration table read every statement figure 1,000x too small, and
  // the operating-profit tripwire cannot see a consistent error. Each block now reads the nearest
  // caption above it (heading or column header), and the document default is the first primary
  // statement's caption.
  suite("QA03 D1 / the scale caption applies per statement block, not per PDF");
  const D1_DEFECT = "Consolidated income statement £m\nRevenue 1,234.5\nDirectors' remuneration £'000\nSalary 500";
  const d1Value = (text: string, metric: string) =>
    extractFinancialsFromText(`${text}${PAD}`)?.lines.find((l) => l.metric === metric)?.value ?? null;
  test("the document default is the £m statement's, not a later £'000 table's", () => {
    assertEqual(detectScale(D1_DEFECT), 1_000_000, "document default");
  });
  test("the £m statement's revenue reads in millions", () => {
    assertEqual(d1Value(D1_DEFECT, "turnover"), 1_234_500_000, "revenue");
  });
  test("a £m primary statement with a £'000 note: each at its own scale", () => {
    const text = [
      "Consolidated income statement",
      "for the year ended 31 December 2025",
      "2025 £m 2024 £m",
      "Revenue 3 1,234.5 1,100.2",
      "Operating profit 210.4 190.0",
      "Consolidated balance sheet",
      "£m",
      "Cash and cash equivalents 15 88.1 70.0",
      "12 Interest payable",
      "£'000 £'000",
      "Interest payable and similar expenses 4,250 3,900",
    ].join("\n");
    assertEqual(d1Value(text, "turnover"), 1_234_500_000, "revenue in £m");
    assertEqual(d1Value(text, "operatingProfit"), 210_400_000, "operating profit in £m");
    assertEqual(d1Value(text, "cash"), 88_100_000, "cash in £m");
    assertEqual(d1Value(text, "netInterest"), 4_250_000, "note in £'000");
  });
  test("a £m remuneration table before the statements does not scale a £'000 document", () => {
    const text = [
      "Figures in £'000",
      "Directors' report",
      "Directors' remuneration £m",
      "Aggregate emoluments 1.2 1.1",
      "Group income statement",
      "Turnover 12,345 11,000",
      "Operating profit 1,234 1,000",
    ].join("\n");
    assertEqual(detectScale(text), 1_000, "document default");
    assertEqual(d1Value(text, "turnover"), 12_345_000, "turnover in £'000");
    assertEqual(d1Value(text, "operatingProfit"), 1_234_000, "operating profit in £'000");
  });
  test("a £'000 document with one £m table: only that table is in millions", () => {
    const text = [
      "Figures in £'000",
      "Income statement",
      "Turnover 12,345 11,000",
      "Operating profit 1,234 1,000",
      "Notes to the financial statements",
      "18 Borrowings",
      "2025 £m 2024 £m",
      "Bank loans and borrowings 45.5 40.0",
      "19 Cash",
      "Cash at bank and in hand 2,500 2,100",
    ].join("\n");
    assertEqual(detectScale(text), 1_000, "a £m note does not become the document default");
    assertEqual(d1Value(text, "turnover"), 12_345_000, "turnover in £'000");
    assertEqual(d1Value(text, "borrowings"), 45_500_000, "the £m table");
    assertEqual(d1Value(text, "cash"), 2_500_000, "the next note goes back to the default");
  });
  test("a caption in the column header governs the rows below it", () => {
    const text = "Consolidated balance sheet\nNote 2025 £'000 2024 £'000\nCash at bank and in hand 15 1,234 1,100";
    assertEqual(d1Value(text, "cash"), 1_234_000, "column-header £'000");
    const group = "Consolidated balance sheet\nGroup 2025 £m Company 2025 £'000\nCash and cash equivalents 1,234.5 900";
    assertEqual(d1Value(group, "cash"), 1_234_500_000, "the first column's caption");
  });
  test("a caption printed on the row scales that row only", () => {
    const text = "Figures in £'000\nIncome statement\nTurnover £m 1,234.5\nOperating profit 1,234";
    assertEqual(d1Value(text, "turnover"), 1_234_500_000, "the row's own £m");
    assertEqual(d1Value(text, "operatingProfit"), 1_234_000, "the next row keeps the block's £'000");
  });
  test("caption spellings: £'m, £000, £ thousands, £ millions, £'000, £m", () => {
    assertEqual(detectScale("Income statement £'m\nTurnover 12.5"), 1_000_000, "£'m");
    assertEqual(detectScale("Income statement £000\nTurnover 12,500"), 1_000, "£000");
    assertEqual(detectScale("Income statement £ thousands\nTurnover 12,500"), 1_000, "£ thousands");
    assertEqual(detectScale("Income statement £ millions\nTurnover 12.5"), 1_000_000, "£ millions");
    assertEqual(detectScale("Income statement £'000\nTurnover 12,500"), 1_000, "£'000");
    assertEqual(detectScale("Income statement £m\nTurnover 12.5"), 1_000_000, "£m");
    assertEqual(d1Value("Income statement\n2025 £'m\nTurnover 12.5 11.0", "turnover"), 12_500_000, "£'m header");
    assertEqual(d1Value("Income statement\n2025 £000\nTurnover 12,500 11,000", "turnover"), 12_500_000, "£000 header");
    assertEqual(d1Value("Income statement\n£ thousands\nTurnover 12,500 11,000", "turnover"), 12_500_000, "£ thousands header");
  });
  test("prose figures and '£1 each' are not captions", () => {
    const text = "Figures in £'000\nIncome statement\nOrdinary shares of £1 each\nRevenue rose to £12m in the year\nTurnover 12,345 11,000";
    assertEqual(d1Value(text, "turnover"), 12_345_000, "still £'000");
  });
  test("no caption anywhere still abstains", () => {
    assertEqual(extractFinancialsFromText(`Income statement\nTurnover 12,345 11,000${PAD}`), null, "abstain");
  });

  // -------------------------------------------------------------------------------------------
  // F6. Login and register echoed the tenant id in their JSON. Nothing reads it, and while the
  // anonymous fallback is on (AUTH_REQUIRED unset) a tenant id presented as the `tid` cookie
  // opens that workspace. The echo is removed; the cookie itself is D3 below.
  // -------------------------------------------------------------------------------------------
  suite("QA03 F6 / login and register do not hand out the tenant id");
  test("neither success body carries tenantId", () => {
    for (const f of ["login", "register"]) {
      const src = readFileSync(join(HERE, "..", "app", "api", "auth", f, "route.ts"), "utf8");
      assert(!/NextResponse\.json\(\{[^}]*tenantId/.test(src), `${f} echoes tenantId`);
    }
  });

  // -------------------------------------------------------------------------------------------
  // Deferred to WP-QA05. Each records TODAY's behaviour, so the finding stays visible in every
  // test run, and names the assertion to flip when the decision is taken.
  // -------------------------------------------------------------------------------------------
  resetRateLimiterForTests();
  resetAuthStoreForTests();
  await getAuthStore().createUser("known@example.com", hashPassword("already registered"), "t-known");
  const knownEmail = await statusOf(register(post("http://x/api/auth/register", JSON.stringify({ email: "known@example.com", password: "long enough pw" }), "198.51.100.9")));
  resetRateLimiterForTests();
  resetAuthStoreForTests();

  suite("QA03 D2 / register tells a caller which emails have accounts (KNOWN DEFECT, WP-QA05)");
  test("KNOWN DEFECT: an existing email answers 409, so accounts can be enumerated", () => {
    // Login is careful (generic 401, dummy hash); register undoes it. The fix is a product call:
    // answer 200 and send "you already have an account" by email, or accept the leak behind the
    // F3 throttle. Flip to assert the answer is indistinguishable from a new registration.
    assertEqual(knownEmail, 409, "KNOWN DEFECT: flip when fixed");
  });

  suite("QA03 D3 / an anonymous tid cookie can name any tenant (FIXED in WP-QA05)");
  test("fixed: the tid cookie is signed and anonymous ids are prefixed, see test/qa05.test.ts", () => {
    // lib/tenant.ts returned the raw tid cookie and middleware.ts accepted any existing value, and
    // registered and anonymous tenants shared one id space. The parsing now lives in the pure
    // lib/auth/tenantCookie.ts, which test/qa05.test.ts exercises directly (suite "QA05 D3").
  });

  const spoofed = clientIp(new Headers({ "x-real-ip": "1.1.1.1", "x-forwarded-for": "2.2.2.2, 10.0.0.1" }));
  suite("QA03 D4 / clientIp trusts client-set headers (KNOWN DEFECT, WP-QA05)");
  test("KNOWN DEFECT: a caller-supplied X-Real-IP is taken as the address", () => {
    // Safe on Vercel, which overwrites both headers; on any other host each request can claim a
    // new address and step round every per-IP limit, including F3's. Needs a TRUSTED_PROXY
    // setting. Flip when fixed.
    assertEqual(spoofed, "1.1.1.1", "KNOWN DEFECT: flip when fixed");
  });

  // -------------------------------------------------------------------------------------------
  // S1. The shared-learning review queue listed every candidate to any signed-in tenant, so one
  // desk's confirmed wording ("project lighthouse facility" -> ebitda) was readable by every
  // other desk with a single contributor behind it.
  // -------------------------------------------------------------------------------------------
  const shared = new InMemorySharedLearningStore();
  await shared.contribute("project lighthouse facility", "ebitda", "desk-a");
  for (const t of ["d1", "d2", "d3"]) await shared.contribute("adjusted ebitda", "ebitda", t);
  const seenByDesk = (await visibleCandidates(shared, false)).map((c) => c.labelNorm);
  const seenByAdmin = (await visibleCandidates(shared, true)).map((c) => c.labelNorm);
  const sharedRoute = readFileSync(join(HERE, "..", "app", "api", "onboarding", "shared", "route.ts"), "utf8");
  // The GET handler only; POST promote reads the raw queue and runs the k gate itself.
  const sharedSrc = sharedRoute.slice(sharedRoute.indexOf("export async function GET"), sharedRoute.indexOf("export async function POST"));

  suite("QA03 S1 / a candidate below k is not shown to other desks");
  test("a desk sees only candidates at k or above", () => {
    assert(!seenByDesk.includes("project lighthouse facility"), `desk saw: ${seenByDesk.join(", ")}`);
    assert(seenByDesk.includes("adjusted ebitda"), `k = ${DEFAULT_K} reached, so it is listed`);
  });
  test("the admin reviewer still sees the whole queue", () => {
    assert(seenByAdmin.includes("project lighthouse facility"), "admin");
  });
  test("the route lists through visibleCandidates, not the raw store", () => {
    assert(!/store\.listCandidates\(\)/.test(sharedSrc), "GET calls store.listCandidates() unfiltered");
  });

  // -------------------------------------------------------------------------------------------
  // S2. Removing a company from the watchlist kept its snapshot. Re-added later, the first check
  // diffed against that old baseline and reported every change since as new today.
  // -------------------------------------------------------------------------------------------
  const mon = new InMemoryMonitorStore();
  const snap: Snapshot = {
    tenantId: "qa03-mon",
    chNumber: "00445790",
    takenAt: "2026-01-01T00:00:00Z",
    companyStatus: "active",
    charges: [],
    pscIds: [],
    officerIds: [],
    accountsOverdue: false,
  } as unknown as Snapshot;
  await mon.addToWatchlist("qa03-mon", "00445790");
  await mon.saveSnapshot(snap);
  await mon.removeFromWatchlist("qa03-mon", "00445790");
  await mon.addToWatchlist("qa03-mon", "00445790");
  const oldBaseline = await mon.loadSnapshot("qa03-mon", "00445790");

  suite("QA03 S2 / a re-added watch starts a new baseline");
  test("removing a watch drops its snapshot", () => {
    assertEqual(oldBaseline, null, "the January snapshot survived the removal");
  });

  // S3. The Postgres monitor store trimmed only the ends of a company number; the memory store
  // strips all whitespace. Postgres is not run in this suite, so the normaliser is read.
  const pgMon = readFileSync(join(HERE, "..", "lib", "monitor", "postgres.ts"), "utf8");
  suite("QA03 S3 / both monitor stores key a company number the same way");
  test("the Postgres normaliser strips inner whitespace", () => {
    assert(!/return chNumber\.trim\(\)\.toUpperCase\(\)/.test(pgMon), "Postgres keys '12 345 678' apart from '12345678'");
  });

  // -------------------------------------------------------------------------------------------
  // S4. A blank company number took a place in the screening cap, was counted nowhere, and
  // pushed a real member into `skipped`.
  // -------------------------------------------------------------------------------------------
  const screened: string[] = [];
  const blankFirst = await screenUniverse("qa03-scr", {}, [{ chNumber: " " }, { chNumber: "00445790" }], new InMemoryGraphStore(), {
    cap: 1,
    screen: (async (_t: string, n: string) => {
      screened.push(n);
      return null;
    }) as never,
  });

  suite("QA03 S4 / blank numbers do not use up the screening cap");
  test("with cap 1, the real member is screened", () => {
    assertEqual(screened.join(","), "00445790", "screened");
    assertEqual(blankFirst.skipped, 0, "nothing real was skipped");
  });

  // -------------------------------------------------------------------------------------------
  // E1. PDF text-layer figures were dated by the profile's last-accounts date (cached an hour),
  // not by the filing that was read. With the profile on 2024 and the chosen filing made up to
  // 2023, 2023's figures landed as FY2024.
  // -------------------------------------------------------------------------------------------
  const pdf = extractFinancialsFromText(`Figures in £'000\nCash at bank and in hand 15 1,234 1,100${PAD}`)!;
  const profile2024 = {
    company_name: "EXAMPLE LIMITED",
    company_number: "01234567",
    company_status: "active",
    accounts: { last_accounts: { made_up_to: "2024-12-31", type: "full" } },
  } as never;
  const dated = mapLiveToManifest(profile2024, { items: [] } as never, {
    extracted: textLayerExtraction(pdf, "2023-12-31", profile2024),
  });

  suite("QA03 E1 / a text-layer figure carries the period of the filing it was read from");
  test("figures from the 2023 filing land as FY2023, not as the profile's FY2024", () => {
    assertEqual(dated.facts["cash.FY2023"]?.value ?? null, 1_234_000, "cash.FY2023");
    assert(typeof dated.facts["cash.FY2024"]?.value !== "number", "no cash figure under FY2024");
  });

  // -------------------------------------------------------------------------------------------
  // E2. The iXBRL document cache was keyed by company number alone, so for six hours after a new
  // filing the builder cited filing B while reading filing A's cached figures.
  // -------------------------------------------------------------------------------------------
  resetCacheForTests();
  const savedKey = process.env.CH_API_KEY;
  const savedFetch = globalThis.fetch;
  process.env.CH_API_KEY = "qa03-test-key";
  await getCache().set("ch:accounts-ixbrl:01234567", "<html>FILING A</html>", 3600); // the old key
  await getCache().set("ch:accounts-ixbrl:01234567:TX-A", "<html>FILING A</html>", 3600);
  globalThis.fetch = (async () => new Response("<html>FILING B</html>", { status: 200, headers: { "content-type": "application/xhtml+xml" } })) as typeof fetch;
  let served = "not run";
  try {
    served =
      (await getLatestAccountsIxbrl("01234567", {
        filing: { transactionId: "TX-B", type: "AA", madeUpDate: "2025-12-31", filedOn: "2026-09-01", description: "", accountsType: "full" as never, documentMetadataUrl: "https://x/meta", formats: { ixbrl: true, pdf: false } },
        formats: { ixbrl: true, pdf: false },
        contentUrl: "https://document-api.company-information.service.gov.uk/document/B/content",
        pageCount: 0,
      })) ?? "null";
  } catch (e) {
    served = `threw: ${(e as Error).message}`;
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.CH_API_KEY;
    else process.env.CH_API_KEY = savedKey;
    resetCacheForTests();
  }

  suite("QA03 E2 / the iXBRL cache serves the filing that was chosen");
  test("with filing A cached and filing B chosen, B's document is read", () => {
    assert(served.includes("FILING B"), `served: ${served}`);
  });
}
