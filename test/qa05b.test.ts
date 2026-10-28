// test/qa05b.test.ts
// WP-QA05 part 2: the WP-QA03 findings deferred without a test ("Deferred without a test" in
// docs/programme/reports/WP-QA03.md), less the three part 1 took (tenant cookie, k-anonymity,
// monitor double events). Each case failed before its fix; the ranking is in
// docs/programme/reports/WP-QA05-part2.md. A case that waits on a product decision is a skip()
// with the decision spelled out.
//
// No network and no model. The vision reads are hand-built, shaped as the reads return them;
// none is a gold figure. The Postgres case runs the store's own SQL against a stand-in client
// that models READ COMMITTED and row locks, because there is no database here.

import { suite, test, skip, assert, assertEqual } from "./harness";
import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { SecondReadWire, SecondWireLine, SecondWireTieLine, TieRole } from "../lib/vision/secondRead";
import { doubleReadProblem, judgeDoubleRead, netDebtReadings } from "../lib/vision/verify";
import { BASE_LINE_KEYS, type BaseLineKey, type FoundLine, type VisionLine, type VisionReadResult } from "../lib/vision/types";
import { labelFigures, type SheetOf } from "../lib/engine/figureBasis";
import type { CapitalStructure, Fact, FactManifest, FactPrecision } from "../lib/engine/types";
import { runStructuralChecks } from "../lib/engine/verify";
import { addPrecision, precisionFromDecimals, precisionFromPrinted, precisionFromValue } from "../lib/engine/precision";
import { extractFinancials, parseIxbrl } from "../lib/sources/ixbrl";
import { extractFinancialsFromText } from "../lib/sources/pdfAccounts";
import { mapLiveToManifest, selectAccountsDocument } from "../lib/sources/companiesHouseLive";
import { PostgresClientSpecStore, setClientSpecSqlForTests, type Sql } from "../lib/clientspec/postgres";
import type { ClientSpec } from "../lib/clientspec/types";
import { detectContradictions } from "../lib/kb/check";
import { InMemoryMonitorStore } from "../lib/monitor/store";
import { InMemoryShortlistStore } from "../lib/store/shortlistStore";
import type { OriginationSuggestion } from "../lib/originate/suggestion";
import { issueSession, sessionCookieOptions, type CookieJar, type SessionCookieOptions } from "../lib/auth/issue";
import { InMemoryAuthStore, SESSION_HANDLE_COOKIE } from "../lib/auth/store";
import { readNetworkBody } from "../lib/onboarding/networkBody";

const HERE = dirname(fileURLToPath(import.meta.url));
const PERIOD = "2025-12-31";

// --- Vision builders ------------------------------------------------------------

// A figure as printed on the balance sheet, page 5, in £m.
type Printed = { text: string; label?: string; period?: string };

function found(key: BaseLineKey, p: Printed): FoundLine {
  const negative = p.text.startsWith("(");
  const magnitude = Number(p.text.replace(/[(),]/g, ""));
  return {
    status: "found",
    printedLabel: p.label ?? key,
    figureText: p.text,
    value: negative ? -magnitude : magnitude,
    sign: negative ? "negative" : "positive",
    scaleCaption: "£m",
    pdfPageIndex: 5,
    printedPageNumber: null,
    statement: "Balance sheet",
    periodEnd: p.period ?? PERIOD,
    noteReference: null,
  };
}

function readOf(printed: Partial<Record<BaseLineKey, Printed>>, documentPeriod: string | null = PERIOD): VisionReadResult {
  const lines = Object.fromEntries(
    BASE_LINE_KEYS.map((k) => [k, printed[k] ? found(k, printed[k]!) : { status: "abstain", reason: "not-printed" }])
  ) as Record<BaseLineKey, VisionLine>;
  return {
    outcome: "read",
    fromCache: false,
    cacheKey: "qa05b",
    schemaVersion: 2,
    promptVersion: "p2",
    model: "claude-opus-5",
    transactionId: "qa05b-tx",
    companyNumber: "00000005",
    pageSet: "subset",
    document: { companyNameAsPrinted: "QA05B LIMITED", periodEnd: documentPeriod, currency: "GBP", basis: null },
    lines,
    debtNote: { status: "abstain", reason: "not-read" },
    usage: null,
    recordedUsage: null,
  };
}

type Tie = { text: string; label: string; period?: string };

function wireOf(printed: Partial<Record<BaseLineKey, Printed>>, ties: Partial<Record<TieRole, Tie>>): SecondReadWire {
  const lines: SecondWireLine[] = BASE_LINE_KEYS.filter((k) => printed[k]).map((k) => {
    const p = printed[k]!;
    const period = p.period ?? PERIOD;
    return {
      key: k,
      status: "found",
      abstain_reason: "",
      printed_label: p.label ?? k,
      figure_text: p.text,
      sign: p.text.startsWith("(") ? "negative" : "positive",
      scale_caption: "£m",
      header_scale_caption: "£m",
      header_currency: "£",
      column_heading: period.slice(0, 4),
      header_rows_above: [],
      period_end: period,
      excerpt_page: 1,
      statement: "Balance sheet",
      basis: "none",
      basis_text: "",
    };
  });
  const tie_lines: SecondWireTieLine[] = (["total_equity", "total_liabilities", "current_assets", "borrowings_total", "net_debt"] as const).map((role) => {
    const t = ties[role];
    if (!t) {
      return { role, status: "abstain", abstain_reason: "not-printed", printed_label: "", figure_text: "", sign: "none", scale_caption: "", column_heading: "", period_end: "", excerpt_page: 0 };
    }
    const period = t.period ?? PERIOD;
    return {
      role,
      status: "found",
      abstain_reason: "",
      printed_label: t.label,
      figure_text: t.text,
      sign: t.text.startsWith("(") ? "negative" : "positive",
      scale_caption: "£m",
      column_heading: period.slice(0, 4),
      period_end: period,
      excerpt_page: 1,
    };
  });
  return { lines, tie_lines };
}

function judge(printed: Partial<Record<BaseLineKey, Printed>>, ties: Partial<Record<TieRole, Tie>>, documentPeriod: string | null = PERIOD) {
  const read = readOf(printed, documentPeriod);
  return { read, ...judgeDoubleRead(read, wireOf(printed, ties), [5]) };
}

function tieOn(lines: ReturnType<typeof judgeDoubleRead>["lines"], key: BaseLineKey, id: string) {
  const l = lines[key];
  if (l.tag !== "verified" || !l.evidence || l.evidence.kind !== "double-read") return null;
  return l.evidence.ties.find((t) => t.id === id) ?? null;
}

const NET_DEBT = "net-debt.borrowings-cash";

export async function registerQa05bTests(): Promise<void> {
  // --- Med-High: the net debt tie accepted either sign --------------------------------------
  suite("WP-QA05b net debt tie: the printed label settles the sign");

  test("borrowings 100 and cash 300 read swapped do not tie to a printed net debt of 200", () => {
    // The filing: borrowings 300, cash 100, net debt 200. Both reads swapped cash and borrowings.
    const { lines } = judge(
      { cash_at_bank: { text: "300" }, borrowings_within_one_year: { text: "(40)" }, borrowings_after_one_year: { text: "(60)" } },
      { net_debt: { text: "200", label: "Net debt" } }
    );
    assertEqual(lines.cash_at_bank.tag, "rejected", "cash is not shown on a net debt tie that only holds negated");
    assertEqual(lines.borrowings_after_one_year.tag, "rejected", "nor the borrowings");
  });

  test("the true reading still ties: borrowings 300 less cash 100 against net debt 200", () => {
    const { lines } = judge(
      { cash_at_bank: { text: "100" }, borrowings_within_one_year: { text: "(100)" }, borrowings_after_one_year: { text: "(200)" } },
      { net_debt: { text: "200", label: "Net debt" } }
    );
    assertEqual(tieOn(lines, "cash_at_bank", NET_DEBT)?.status, "pass", "net debt tie holds");
  });

  test("a printed Net funds of 200 ties to cash 300 less borrowings 100", () => {
    const { lines } = judge(
      { cash_at_bank: { text: "300" }, borrowings_within_one_year: { text: "(40)" }, borrowings_after_one_year: { text: "(60)" } },
      { net_debt: { text: "200", label: "Net funds" } }
    );
    assertEqual(tieOn(lines, "cash_at_bank", NET_DEBT)?.status, "pass", "net funds tie holds");
  });

  test("a bracketed Net debt, as the recorded 03558065 filing prints it, still ties", () => {
    const { lines } = judge(
      { cash_at_bank: { text: "100" }, borrowings_within_one_year: { text: "(100)" }, borrowings_after_one_year: { text: "(200)" } },
      { net_debt: { text: "(200)", label: "Net debt" } }
    );
    assertEqual(tieOn(lines, "cash_at_bank", NET_DEBT)?.status, "pass", "bracketed net debt tie holds");
  });

  test("the readings by label", () => {
    assertEqual(JSON.stringify(netDebtReadings("Net debt", 200)), "[200]", "unbracketed net debt");
    assertEqual(JSON.stringify(netDebtReadings("Net funds", 200)), "[-200]", "net funds");
    assertEqual(JSON.stringify(netDebtReadings("NET CASH", -50)), "[50]", "bracketed net cash is net debt");
    assertEqual(JSON.stringify(netDebtReadings("Net debt", -200)), "[-200,200]", "bracketed net debt keeps both");
  });

  skip(
    "a bracketed Net debt is read as debt only, so a swapped read fails there too",
    `Cam or the engine owner (WP-BE14): what does "Net debt" printed in brackets mean? The one recorded
filing (03558065, net debt analysis) prints net debt of 276.4 as "(276.4)" because its table shows debt
as negative. A table that shows debt as positive would print net CASH of 276.4 the same way. Reading
brackets as debt only closes the swap on bracketed filings too, and makes a genuine net-cash company
printed that way fail the tie and abstain its cash and borrowings (safe, but a loss of coverage).
Keeping both readings, as now, keeps that coverage and leaves the swap open on bracketed filings.`,
    () => {
      const { lines } = judge(
        { cash_at_bank: { text: "300" }, borrowings_within_one_year: { text: "(40)" }, borrowings_after_one_year: { text: "(60)" } },
        { net_debt: { text: "(200)", label: "Net debt" } }
      );
      assertEqual(lines.cash_at_bank.tag, "rejected", "swapped read against bracketed net debt");
    }
  );

  // --- Med-High: the net debt tie bound lines it did not use ---------------------------------
  suite("WP-QA05b net debt tie: only the lines the arithmetic used are bound");

  test("a lone maturity line is not vouched for when the printed total did the arithmetic", () => {
    const { lines } = judge(
      { cash_at_bank: { text: "100" }, borrowings_after_one_year: { text: "(250)" } },
      { borrowings_total: { text: "300", label: "Total borrowings" }, net_debt: { text: "200", label: "Net debt" } }
    );
    assertEqual(tieOn(lines, "cash_at_bank", NET_DEBT)?.status, "pass", "the tie ran on the total and passed");
    assertEqual(lines.borrowings_after_one_year.tag, "verified", "the lone line is still verified by its two reads");
    assertEqual(tieOn(lines, "borrowings_after_one_year", NET_DEBT), null, "but carries no net debt tie it took no part in");
  });

  test("a failed tie on the printed total does not condemn a lone maturity line", () => {
    const { lines } = judge(
      { cash_at_bank: { text: "100" }, borrowings_after_one_year: { text: "(250)" } },
      { borrowings_total: { text: "300", label: "Total borrowings" }, net_debt: { text: "500", label: "Net debt" } }
    );
    assertEqual(lines.cash_at_bank.tag, "rejected", "cash was in the arithmetic, so it is rejected");
    assertEqual(lines.borrowings_after_one_year.tag, "verified", "the lone line was not, so it stands");
  });

  test("with both maturity lines agreed, both are bound as before", () => {
    const { lines } = judge(
      { cash_at_bank: { text: "100" }, borrowings_within_one_year: { text: "(100)" }, borrowings_after_one_year: { text: "(200)" } },
      { net_debt: { text: "200", label: "Net debt" } }
    );
    assertEqual(tieOn(lines, "borrowings_within_one_year", NET_DEBT)?.status, "pass", "within one year bound");
    assertEqual(tieOn(lines, "borrowings_after_one_year", NET_DEBT)?.status, "pass", "after one year bound");
  });

  // --- Low-Med: the tie period checks switched off with no document period --------------------
  suite("WP-QA05b ties: the period check holds when the accounts period is missing");

  test("a total read off the comparative column does not tie this year's net assets", () => {
    const { lines } = judge({ net_assets: { text: "500" } }, { total_equity: { text: "500", label: "Total equity", period: "2024-12-31" } }, null);
    const t = tieOn(lines, "net_assets", "balance-sheet.net-assets-equity");
    assert(t !== null, "the tie is on the record");
    assert(t!.status !== "pass", `the tie must not pass on a total for another period, got ${t!.status}: ${t!.detail}`);
  });

  test("the same total for the lines' own period still ties", () => {
    const { lines } = judge({ net_assets: { text: "500" } }, { total_equity: { text: "500", label: "Total equity" } }, null);
    assertEqual(tieOn(lines, "net_assets", "balance-sheet.net-assets-equity")?.status, "pass", "tie holds on the lines' period");
  });

  // --- Low-Med: the landing rule did not re-check currency -----------------------------------
  suite("WP-QA05b landing rule: a figure with euro evidence does not land");

  test("a verifier that records EUR evidence cannot land the figure as pounds", () => {
    const { read, lines } = judge({ net_assets: { text: "500" } }, {});
    const tag = lines.net_assets;
    assertEqual(tag.tag, "verified", "the default verifier verifies the sterling line");
    const line = read.lines.net_assets as FoundLine;
    assertEqual(doubleReadProblem(line, tag), null, "sterling evidence lands");
    const euro = structuredClone(tag);
    if (euro.evidence?.kind === "double-read") euro.evidence.second.currency = "EUR";
    const problem = doubleReadProblem(line, euro);
    assert(problem !== null && problem.includes("EUR"), `euro evidence must not land, got ${problem}`);
  });

  // --- Medium: the facilities table on a parent-group sheet -----------------------------------
  suite("WP-QA05b parent-group sheet: the facilities table is labelled and checked");

  const parentSheet = (transactionId: string): SheetOf => ({
    kind: "parent-group",
    entity: { number: "00000001", name: "PARENT GROUP PLC" },
    subject: { number: "00000002", name: "SUBSIDIARY LIMITED" },
    filing: { type: "AA", accountsType: "group", madeUpDate: PERIOD, filedOn: "2026-04-01", transactionId },
  });
  const table = (transactionId: string): CapitalStructure => ({
    status: "found",
    reason: null,
    verifier: "facility-read/v1",
    transactionId,
    pages: [30],
    noteHeading: "Borrowings",
    scaleCaption: "£m",
    rows: [{ id: "f1", status: "found", name: "Term loan", type: "term_loan", page: 30, cells: {} as never, citation: "p30", reason: null }],
    notes: [],
    fulcrumStated: false,
  });
  const manifestWith = (cs: CapitalStructure) => ({ entity: {}, facts: {}, sources: {}, generatedAt: "", capitalStructure: cs }) as unknown as FactManifest;

  test("a table read from another filing than the parent's group accounts abstains whole", () => {
    const m = manifestWith(table("TX-SUBSIDIARY-OWN"));
    const out = labelFigures(m, parentSheet("TX-PARENT-GROUP"));
    assertEqual(m.capitalStructure!.status, "abstain", "the table abstains");
    assertEqual(m.capitalStructure!.rows.length, 0, "no facility row is shown");
    assert(out.abstained.some((a) => a.id === "capitalStructure"), "the abstention is reported");
  });

  test("the parent's own table carries the parent-group label", () => {
    const m = manifestWith(table("TX-PARENT-GROUP"));
    labelFigures(m, parentSheet("TX-PARENT-GROUP"));
    assertEqual(m.capitalStructure!.status, "found", "the table stands");
    assertEqual(m.capitalStructure!.basis?.kind, "parent-group", "labelled as the parent group's");
    assertEqual(m.capitalStructure!.basis?.entity.number, "00000001", "naming the parent");
  });

  // --- Low-Med: a failed filing-history fetch read as "no accounts filing" --------------------
  suite("WP-QA05b Companies House: a filing-history outage is not an empty register");

  test("selectAccountsDocument throws when the filing history cannot be fetched", async () => {
    const savedKey = process.env.CH_API_KEY;
    const savedFetch = globalThis.fetch;
    process.env.CH_API_KEY = "qa05b-test-key";
    globalThis.fetch = (async () => new Response("upstream down", { status: 503 })) as typeof fetch;
    let threw = false;
    let result: unknown = "not reached";
    try {
      result = await selectAccountsDocument("01234567");
    } catch {
      threw = true;
    } finally {
      globalThis.fetch = savedFetch;
      if (savedKey === undefined) delete process.env.CH_API_KEY;
      else process.env.CH_API_KEY = savedKey;
    }
    assert(threw, `a 503 must not read as "no accounts filing", got ${JSON.stringify(result)}`);
  });

  test("the manifest says the accounts were not checked, not that none were filed", () => {
    const profile = {
      company_name: "OUTAGE LIMITED",
      company_number: "01234567",
      company_status: "active",
      accounts: { last_accounts: { made_up_to: PERIOD, type: "full" } },
    } as never;
    const m = mapLiveToManifest(profile, { items: [] } as never, { filingFetchFailed: true });
    const gap = Object.values(m.facts).find((f) => f.metric === "dataGap.accounts");
    assert(gap, "a dataGap.accounts marker is on the manifest");
    assert(String(gap!.value).includes("not a finding"), "and it says the empty financials are not a finding");
    const quiet = mapLiveToManifest(profile, { items: [] } as never, {});
    assert(!Object.values(quiet.facts).some((f) => f.metric === "dataGap.accounts"), "no marker when the fetch worked");
  });

  // --- Medium: ClientSpec Postgres save raced on max(version)+1 -------------------------------
  suite("WP-QA05b ClientSpec Postgres: two saves at once both succeed");

  test("two concurrent saves get versions 1 and 2, not a primary key clash", async () => {
    const db = new FakeDb();
    setClientSpecSqlForTests(db.sql());
    try {
      const store = new PostgresClientSpecStore();
      const spec = { version: 0 } as unknown as ClientSpec;
      const results = await Promise.allSettled([store.saveSpec("desk-a", spec), store.saveSpec("desk-a", spec)]);
      const failed = results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason));
      assertEqual(failed.length, 0, `no save fails: ${failed.join("; ")}`);
      const versions = results.map((r) => (r as PromiseFulfilledResult<number>).value).sort();
      assertEqual(versions.join(","), "1,2", "versions are 1 and 2");
    } finally {
      setClientSpecSqlForTests(null);
    }
  });

  // --- Low-Med: audit_log had tenant_id and no row-level security -----------------------------
  suite("WP-QA05b migrations: audit_log is behind row-level security");

  test("a migration enables, forces and scopes RLS on audit_log", () => {
    const dir = join(HERE, "..", "db", "migrations");
    const sql = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => readFileSync(join(dir, f), "utf8"))
      .join("\n");
    assert(sql.includes("alter table audit_log enable row level security"), "RLS enabled on audit_log");
    assert(sql.includes("alter table audit_log force  row level security"), "RLS forced on audit_log");
    assert(
      /create policy audit_log_tenant on audit_log\s+using \(tenant_id = current_setting\('app\.tenant_id', true\)\)\s+with check \(tenant_id = current_setting\('app\.tenant_id', true\)\)/.test(sql),
      "a tenant policy with using and with check"
    );
  });

  // --- Low: the small ones --------------------------------------------------------------------
  suite("WP-QA05b low: kb/check keeps dotted metrics whole");

  test("a securedVintage.7 contradiction names the metric and the period correctly", () => {
    const fact = (id: string, value: number, sourceId: string) =>
      ({ id, metric: "securedVintage.7", period: PERIOD, value, provenance: { sourceId, tag: "Reg" } }) as unknown as Fact;
    const out = detectContradictions([fact("a", 100, "s1"), fact("b", 200, "s2")]);
    assertEqual(out.length, 1, "one contradiction");
    assertEqual(out[0].metric, "securedVintage.7", "metric kept whole");
    assertEqual(out[0].period, PERIOD, "period is the period");
  });

  suite("WP-QA05b low: lists sort the same way whatever the insertion order");

  test("a watchlist with two companies added in the same instant", async () => {
    const orders = await frozenClock(async () => {
      const one = new InMemoryMonitorStore();
      await one.addToWatchlist("t", "00000002");
      await one.addToWatchlist("t", "00000001");
      const two = new InMemoryMonitorStore();
      await two.addToWatchlist("t", "00000001");
      await two.addToWatchlist("t", "00000002");
      return [(await one.listWatchlist("t")).map((e) => e.chNumber).join(","), (await two.listWatchlist("t")).map((e) => e.chNumber).join(",")];
    });
    assertEqual(orders[0], orders[1], "same order either way");
  });

  test("a shortlist with two suggestions saved in the same instant", async () => {
    const s = (number: string) => ({ target: { number, name: number } }) as unknown as OriginationSuggestion;
    const orders = await frozenClock(async () => {
      const one = new InMemoryShortlistStore();
      await one.save("t", s("00000002"));
      await one.save("t", s("00000001"));
      const two = new InMemoryShortlistStore();
      await two.save("t", s("00000001"));
      await two.save("t", s("00000002"));
      const ids = async (st: InMemoryShortlistStore) => (await st.list("t")).map((x) => (x as unknown as { target: { number: string } }).target.number).join(",");
      return [await ids(one), await ids(two)];
    });
    assertEqual(orders[0], orders[1], "same order either way");
  });

  suite("WP-QA05b low: signing in revokes the old session handle and sets Secure by isProd()");

  test("a second login revokes the handle the browser already held", async () => {
    const store = new InMemoryAuthStore();
    const user = await store.createUser("a@example.com", "scrypt$x$y", "tenant-a");
    const jar = new FakeJar();
    await issueSession(jar, store, user);
    const first = jar.get(SESSION_HANDLE_COOKIE)!.value;
    assert(await store.loadSession(first), "the first handle is live");
    await issueSession(jar, store, user);
    const second = jar.get(SESSION_HANDLE_COOKIE)!.value;
    assert(second !== first, "a new handle is issued");
    assertEqual(await store.loadSession(first), null, "the old handle no longer resolves");
    assert(await store.loadSession(second), "the new one does");
  });

  test("a Vercel production deployment without NODE_ENV gets Secure cookies", () => {
    assertEqual(sessionCookieOptions({ VERCEL_ENV: "production" } as unknown as NodeJS.ProcessEnv).secure, true, "VERCEL_ENV=production is production");
    assertEqual(sessionCookieOptions({ NODE_ENV: "development" } as unknown as NodeJS.ProcessEnv).secure, false, "dev stays plain for localhost");
  });

  test("both auth routes issue sessions through issueSession, not their own cookie code", () => {
    for (const route of ["login", "register"]) {
      const src = readFileSync(join(HERE, "..", "app", "api", "auth", route, "route.ts"), "utf8");
      assert(src.includes("issueSession("), `${route} uses issueSession`);
      assert(!src.includes("NODE_ENV"), `${route} does not decide Secure from NODE_ENV`);
    }
  });

  suite("WP-QA05b low: the network step needs a relationships list");

  test("a null or empty body is refused, so the step is not marked complete", () => {
    assertEqual(readNetworkBody({}).ok, false, "{} (what a null body parses to) is refused");
    assertEqual(readNetworkBody({ relationships: "x" }).ok, false, "a non-list is refused");
    assertEqual(readNetworkBody({ firmName: "Desk" }).ok, false, "a firm name alone is refused");
  });

  test("an empty list is the wizard's 'none to add' and completes the step", () => {
    const r = readNetworkBody({ relationships: [] });
    assert(r.ok && r.relationships.length === 0, "empty list accepted");
  });

  test("the route refuses before it advances the onboarding state", () => {
    const src = readFileSync(join(HERE, "..", "app", "api", "onboarding", "network", "route.ts"), "utf8");
    const refuse = src.indexOf("status: 400");
    const advance = src.indexOf("completedSteps.push");
    assert(refuse > 0 && advance > refuse, "the 400 comes before the step is marked complete");
  });

  // --- QA05 skip 2: tolerance from printed precision ------------------------------------------
  suite("QA05 skip 2: tolerance from printed precision");

  test("a £m print rounds within half a digit per figure, so a real tie on small totals holds", () => {
    // £3m = £2m + £2m as printed: each is rounded to £1m, so the sum may be out by £1.5m.
    // The flat 0.5% allowed £15k and failed it.
    const facts = sheet([
      ["totalAssets", 3_000_000, millions],
      ["totalLiabilities", 2_000_000, millions],
      ["totalEquity", 2_000_000, millions],
    ]);
    const [check] = runStructuralChecks(facts, FY);
    assert(check.passed, "a £1m gap between three figures rounded to £1m is rounding");
    eq(facts[`totalAssets.${FY}`].verification.status, "STRUCTURAL_PASS");
  });

  test("one decimal in £m allows £150k over three figures and no more", () => {
    const pass = sheet([
      ["totalAssets", 100_100_000, tenths],
      ["totalLiabilities", 60_100_000, tenths],
      ["totalEquity", 39_900_000, tenths],
    ]);
    assert(runStructuralChecks(pass, FY)[0].passed, "£100k on three figures printed to £0.1m passes");
    const fail = sheet([
      ["totalAssets", 100_300_000, tenths],
      ["totalLiabilities", 60_100_000, tenths],
      ["totalEquity", 40_000_000, tenths],
    ]);
    assert(!runStructuralChecks(fail, FY)[0].passed, "£200k on three figures printed to £0.1m fails");
  });

  test("whole pounds tie to the pound", () => {
    const facts = sheet([
      ["currentAssets", 1_250_000, pounds],
      ["creditorsWithinOneYear", 400_000, pounds],
      ["netCurrentAssets", 849_990, pounds],
    ]);
    assert(!runStructuralChecks(facts, FY).find((c) => c.id === `net-current-assets.${FY}`)!.passed, "£10 out on whole-pound figures fails");
  });

  test("a figure with no precision keeps the flat 0.5%, as before", () => {
    const facts = sheet([
      ["totalAssets", 2_000_000_000, millions],
      ["totalLiabilities", 1_200_000_000, undefined],
      ["totalEquity", 791_000_000, millions],
    ]);
    assert(runStructuralChecks(facts, FY)[0].passed, "one input without precision falls back to the flat tolerance");
  });

  test("a precision inferred from the value tightens a check but never loosens it", () => {
    // SEC Company Facts: no decimals and no printed figure, so the unit is read off the value.
    const big = sheet([
      ["totalAssets", 2_000_000_000, fromValue],
      ["totalLiabilities", 1_200_000_000, fromValue],
      ["totalEquity", 791_000_000, fromValue],
    ]);
    assert(!runStructuralChecks(big, FY)[0].passed, "$9m on $2bn fails on inferred $1m precision");
    const small = sheet([
      ["totalAssets", 3_000_000, fromValue],
      ["totalLiabilities", 2_000_000, fromValue],
      ["totalEquity", 2_000_000, fromValue],
    ]);
    assert(!runStructuralChecks(small, FY)[0].passed, "a round value does not buy more than the flat 0.5%");
  });

  test("the sign and scale checks use the same tolerance", () => {
    const facts = sheet([["cash", -400_000, millions]]);
    assert(runStructuralChecks(facts, FY).find((c) => c.id === `sign-cash.${FY}`)!.passed, "cash printed as (0) in £m is rounding, not a sign flip");
    const flipped = sheet([["cash", -600_000, millions]]);
    assert(!runStructuralChecks(flipped, FY).find((c) => c.id === `sign-cash.${FY}`)!.passed, "£0.6m negative cash is a sign flip");
  });

  test("precision units", () => {
    eq(precisionFromDecimals("-6")?.unit, 1_000_000);
    eq(precisionFromDecimals(0)?.unit, 1);
    eq(precisionFromDecimals("INF")?.unit, 0);
    eq(precisionFromDecimals(undefined), undefined);
    eq(precisionFromDecimals("abc"), undefined);
    eq(precisionFromPrinted("(1,234.5)", 1_000_000)?.unit, 100_000);
    eq(precisionFromPrinted("1,234", 1_000)?.unit, 1_000);
    eq(precisionFromValue(1_234_000)?.unit, 1_000);
    eq(precisionFromValue(1_234_567)?.unit, 1);
    assertEqual(precisionFromValue(2_000_000_000)?.unit, 1_000_000, "capped at a million");
    eq(precisionFromValue(0)?.unit, 1_000_000);
    eq(addPrecision({ unit: 1_000, basis: "decimals" }, { unit: 1_000, basis: "value" })?.basis, "value");
    eq(addPrecision({ unit: 1_000, basis: "decimals" }, undefined), undefined);
  });

  test("iXBRL lines carry the filer's decimals, else the printed figure under its scale", () => {
    const xml = ixbrlDoc([
      `<ix:nonFraction name="core:CurrentAssets" contextRef="c1" unitRef="GBP" decimals="-3" scale="3">2,000,000</ix:nonFraction>`,
      `<ix:nonFraction name="core:Creditors" contextRef="c1" unitRef="GBP" scale="6">1.5</ix:nonFraction>`,
      `<ix:nonFraction name="core:Debtors" contextRef="c1" unitRef="GBP" decimals="INF">12</ix:nonFraction>`,
      `<ix:nonFraction name="core:CashBankOnHand" contextRef="c1" unitRef="GBP" format="ixt4:num-comma-decimal" scale="3">1.234,5</ix:nonFraction>`,
    ]);
    const parsed = parseIxbrl(xml);
    const by = (c: string) => parsed.facts.find((f) => f.concept === c)!.precision;
    eq(JSON.stringify(by("CurrentAssets")), JSON.stringify({ unit: 1_000, basis: "decimals" }));
    eq(JSON.stringify(by("Creditors")), JSON.stringify({ unit: 100_000, basis: "printed" }));
    eq(by("Debtors")?.unit, 0);
    assertEqual(by("CashBankOnHand")?.unit, 100, "comma decimal: one decimal under £'000");
    const lines = extractFinancials(xml)!.lines;
    eq(lines.find((l) => l.metric === "currentAssets")?.precision?.unit, 1_000);
  });

  test("the text layer carries the printed figure's precision", () => {
    const text = [
      "Balance sheet as at 31 December 2025",
      "£'000 £'000",
      "Cash at bank and in hand 1,234.5 1,100.0",
      "Turnover 12,345 11,000",
    ].join("\n");
    const pdf = extractFinancialsFromText(text);
    const cash = pdf?.lines.find((l) => l.metric === "cash");
    assert(!!cash, "the fixture text yields a cash line");
    eq(cash!.precision?.unit, 100);
    eq(pdf!.lines.find((l) => l.metric === "turnover")?.precision?.unit, 1_000);
  });

  // --- Decisions, not fixes -------------------------------------------------------------------
  suite("WP-QA05b waiting on a decision");

  // QA05 skip 2, decided: the tolerance comes from the printed precision (lib/engine/precision.ts).
  // The cases for it are in the suite "QA05 skip 2: tolerance from printed precision" below.
  test("an identity out by £9m on £2bn is not a STRUCTURAL_PASS", () => {
    const facts = sheet([
      ["totalAssets", 2_000_000_000, millions],
      ["totalLiabilities", 1_200_000_000, millions],
      ["totalEquity", 791_000_000, millions],
    ]);
    const [check] = runStructuralChecks(facts, FY);
    assert(check && !check.passed, "£9m on £2bn printed in £m fails the balance sheet identity");
    eq(facts[`totalAssets.${FY}`].verification.status, "STRUCTURAL_FAIL");
  });

  skip(
    "a cache-only screen does not reveal that another desk read a filing",
    `Design (WP-QA06): the vision and Companies House caches are keyed by filing, not by tenant, so a
universe screen in cache-only mode surfaces a company because some other desk paid to read it. Adding
the tenant to the key closes the side channel and makes every desk pay for its own read of the same
public filing; keeping it shared saves the spend and leaks interest. The options are (a) tenant in
the key, (b) shared cache but cache-only screens treat another desk's entry as a miss, (c) accept the
leak and say so in the privacy note. Which one is a product call.`,
    () => {
      throw new Error("not written: the expected behaviour is the decision");
    }
  );
}

// --- Stand-ins ----------------------------------------------------------------------------

// Run fn with Date frozen at one instant, so two writes share a timestamp.
async function frozenClock<T>(fn: () => Promise<T>): Promise<T> {
  const Real = Date;
  const at = Real.parse("2026-09-25T00:00:00.000Z");
  class Frozen extends Real {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(at);
      else super(...(args as [string]));
    }
    static now() {
      return at;
    }
  }
  globalThis.Date = Frozen as DateConstructor;
  try {
    return await fn();
  } finally {
    globalThis.Date = Real;
  }
}

class FakeJar implements CookieJar {
  private readonly m = new Map<string, string>();
  get(name: string) {
    const v = this.m.get(name);
    return v === undefined ? undefined : { value: v };
  }
  set(name: string, value: string, _options: SessionCookieOptions) {
    this.m.set(name, value);
  }
}

// Enough of Postgres for PostgresClientSpecStore.saveSpec: READ COMMITTED (a transaction sees
// only committed rows and its own), row locks from `for update` held to commit, and the
// client_spec primary key. Every statement yields first, so two transactions interleave.
class FakeDb {
  private committed: { tenant: string; version: number }[] = [];
  private pending = new Map<number, { tenant: string; version: number }[]>();
  private locks = new Map<string, Promise<void>>();
  private nextTx = 0;

  sql(): Sql {
    const db = this;
    const root = (() => Promise.reject(new Error("statements run inside begin() only"))) as unknown as Sql;
    root.json = (v: unknown) => v;
    root.begin = async <T>(fn: (tx: Sql) => Promise<T>): Promise<T> => {
      const id = db.nextTx++;
      db.pending.set(id, []);
      const releases: (() => void)[] = [];
      const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
        await new Promise((r) => setImmediate(r));
        const text = strings.join("?").replace(/\s+/g, " ").trim();
        if (text.startsWith("select set_config") || text.startsWith("insert into tenant")) return [];
        if (text.includes("for update")) {
          const key = String(values[0]);
          while (db.locks.has(key)) await db.locks.get(key);
          let release!: () => void;
          db.locks.set(key, new Promise<void>((r) => (release = r)));
          releases.push(() => {
            db.locks.delete(key);
            release();
          });
          return [{ id: key }];
        }
        if (text.includes("max(version)")) {
          const tenant = String(values[0]);
          const seen = [...db.committed, ...db.pending.get(id)!].filter((r) => r.tenant === tenant);
          return [{ next: Math.max(0, ...seen.map((r) => r.version)) + 1 }];
        }
        if (text.startsWith("insert into client_spec")) {
          const row = { tenant: String(values[0]), version: Number(values[1]) };
          const all = [...db.committed, ...[...db.pending.values()].flat()];
          if (all.some((r) => r.tenant === row.tenant && r.version === row.version)) {
            throw new Error('duplicate key value violates unique constraint "client_spec_pkey"');
          }
          db.pending.get(id)!.push(row);
          return [];
        }
        throw new Error(`FakeDb: unexpected statement: ${text}`);
      }) as unknown as Sql;
      tx.json = root.json;
      tx.begin = root.begin;
      try {
        const out = await fn(tx);
        db.committed.push(...db.pending.get(id)!);
        return out;
      } finally {
        db.pending.delete(id);
        for (const r of releases) r();
      }
    };
    return root;
  }
}


// --- Precision builders (QA05 skip 2) --------------------------------------------------------

const FY = "FY2025";
const millions: FactPrecision = { unit: 1_000_000, basis: "decimals" };
const tenths: FactPrecision = { unit: 100_000, basis: "printed" };
const pounds: FactPrecision = { unit: 1, basis: "decimals" };
const fromValue = "value" as const;

// Reported R1 facts for one period. A precision of "value" is inferred from the value, as the
// SEC path does; undefined leaves the fact without one, as a fixture is.
function sheet(rows: [string, number, FactPrecision | typeof fromValue | undefined][]): Record<string, Fact> {
  const facts: Record<string, Fact> = {};
  for (const [metric, value, p] of rows) {
    const precision = p === fromValue ? precisionFromValue(value) : p;
    facts[`${metric}.${FY}`] = {
      id: `${metric}.${FY}`,
      metric,
      label: metric,
      period: FY,
      kind: "currency",
      value,
      unit: "GBP",
      rung: "R1",
      provenance: null,
      verification: { status: "SINGLE_SOURCE", checks: [] },
      ...(precision ? { precision } : {}),
    };
  }
  return facts;
}

function eq<T>(actual: T, expected: T, msg = "precision"): void {
  assertEqual(actual, expected, msg);
}

function ixbrlDoc(facts: string[]): string {
  return `<html xmlns:ix="http://www.xbrl.org/2013/inlineXBRL"><body>
<xbrli:context id="c1"><xbrli:period><xbrli:instant>2025-12-31</xbrli:instant></xbrli:period></xbrli:context>
<xbrli:unit id="GBP"><xbrli:measure>iso4217:GBP</xbrli:measure></xbrli:unit>
${facts.join("\n")}
</body></html>`;
}
