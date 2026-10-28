// test/beIdentities.test.ts
// BE identities live: the accounting identities in lib/engine/verify.ts had never run on a live
// UK iXBRL filing, because the reader landed equity as shareholdersFunds (the identity looked for
// totalEquity), never read cost of sales or gross profit, and missed creditors within one year
// where the filer tags it the current FRC way (one Creditors concept on maturity dimensions).
// Each identity newly reachable gets a hand-written iXBRL string that ties, and one that does not.

import { suite, test, assert, assertEqual } from "./harness";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { extractFinancials } from "../lib/sources/ixbrl";
import { mapLiveToManifest } from "../lib/sources/companiesHouseLive";
import { runStructuralChecks } from "../lib/engine/verify";
import type { CompanyProfile, ChargesList } from "../lib/sources/companiesHouse";
import type { Fact, FactManifest } from "../lib/engine/types";

const HERE = dirname(fileURLToPath(import.meta.url));

function profile(): CompanyProfile {
  return {
    company_number: "03454787",
    company_name: "IDENTITY SAMPLE LIMITED",
    company_status: "active",
    type: "ltd",
    date_of_creation: "1997-10-01",
    sic_codes: ["56101"],
    registered_office_address: { country: "United Kingdom" },
    accounts: { last_accounts: { made_up_to: "2025-12-31", type: "full" } },
  } as CompanyProfile;
}
const noCharges: ChargesList = { items: [], total_count: 0 };

// Contexts in the shape 03454787 uses: a duration and an instant for the year, the prior-year
// instant, and creditors on the current / non-current and maturity axes.
const seg = (...members: [string, string][]) =>
  `<xbrli:segment>${members
    .map(([d, m]) => `<xbrldi:explicitMember dimension="d:${d}">d:${m}</xbrldi:explicitMember>`)
    .join("")}</xbrli:segment>`;
const ctx = (id: string, period: string, segment = "") =>
  `<xbrli:context id="${id}"><xbrli:entity><xbrli:identifier scheme="http://www.companieshouse.gov.uk/">03454787</xbrli:identifier>${segment}</xbrli:entity><xbrli:period>${period}</xbrli:period></xbrli:context>`;
const YEAR = "<xbrli:startDate>2025-01-01</xbrli:startDate><xbrli:endDate>2025-12-31</xbrli:endDate>";
const END = "<xbrli:instant>2025-12-31</xbrli:instant>";
const PRIOR = "<xbrli:instant>2024-12-31</xbrli:instant>";
const CUR = "FinancialInstrumentCurrentNon-currentDimension";
const MAT = "MaturitiesOrExpirationPeriodsDimension";

// A figure in £'000 the way the gold filing prints it: decimals -3, scale 3, comma thousands.
const fig = (name: string, context: string, text: string, sign = "") =>
  `<ix:nonFraction contextRef="${context}" decimals="-3" format="ixt:numcommadot" name="d:${name}" scale="3" unitRef="u0"${sign ? ` sign="${sign}"` : ""}>${text}</ix:nonFraction>`;

function filing(body: string[]): string {
  return [
    '<html xmlns:ix="http://www.xbrl.org/2013/inlineXBRL" xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:xbrldi="http://xbrl.org/2006/xbrldi" xmlns:d="http://xbrl.frc.org.uk/fr/2025-01-01/core"><body><ix:header><ix:resources>',
    ctx("c0", YEAR),
    ctx("c2", END),
    ctx("c3", PRIOR),
    ctx("c326", END, seg([CUR, "CurrentFinancialInstruments"])),
    ctx("c350", END, seg([CUR, "CurrentFinancialInstruments"], [MAT, "WithinOneYear"])),
    ctx("c351", PRIOR, seg([CUR, "CurrentFinancialInstruments"], [MAT, "WithinOneYear"])),
    ctx("c354", END, seg([CUR, "Non-currentFinancialInstruments"], [MAT, "AfterOneYear"])),
    ctx("c515", END, seg(["EquityClassesDimension", "RetainedEarningsAccumulatedLosses"])),
    ctx("c900", END, seg([CUR, "CurrentFinancialInstruments"], ["FinancialLiabilitiesTypesDimension", "TradeCreditors"])),
    '<xbrli:unit id="u0"><xbrli:measure>iso4217:GBP</xbrli:measure></xbrli:unit>',
    "</ix:resources></ix:header>",
    ...body,
    "</body></html>",
  ].join("\n");
}

function build(xml: string): FactManifest {
  const ex = extractFinancials(xml);
  assert(ex, "the reader found financial lines");
  return mapLiveToManifest(profile(), noCharges, { extracted: ex! });
}

const PK = "FY2025";
const checkOn = (m: FactManifest, factId: string, checkId: string) =>
  m.facts[factId]?.verification.checks.find((c) => c.id === `${checkId}.${PK}`);

suite("BE identities live / net assets = equity on iXBRL");

test("the FRC Equity concept, landed as shareholdersFunds, now ties to net assets and earns STRUCTURAL_PASS", () => {
  const m = build(filing([fig("NetAssetsLiabilities", "c2", "270,139"), fig("Equity", "c2", "270,139"), fig("Equity", "c515", "154,091")]));
  const c = checkOn(m, `netAssets.${PK}`, "net-assets");
  assert(c, "the net-assets identity ran");
  assert(c!.passed, "and passed");
  assertEqual(m.facts[`shareholdersFunds.${PK}`].value, 270_139_000, "the undimensioned total, not the retained-earnings column");
  assertEqual(m.facts[`netAssets.${PK}`].verification.status, "STRUCTURAL_PASS", "net assets upgraded");
  assertEqual(m.facts[`shareholdersFunds.${PK}`].verification.status, "STRUCTURAL_PASS", "equity upgraded");
  assert(!m.facts[`totalEquity.${PK}`], "no second equity fact was landed");
});

test("a broken net-assets tie fails and both facts show STRUCTURAL_FAIL", () => {
  const m = build(filing([fig("NetAssetsLiabilities", "c2", "270,139"), fig("Equity", "c2", "265,139")]));
  const c = checkOn(m, `netAssets.${PK}`, "net-assets");
  assert(c && !c.passed, "the identity ran and failed (out by 5,000 on a £'000 print, tolerance 1,000)");
  assertEqual(m.facts[`netAssets.${PK}`].verification.status, "STRUCTURAL_FAIL", "net assets flagged");
  assertEqual(m.facts[`shareholdersFunds.${PK}`].verification.status, "STRUCTURAL_FAIL", "equity flagged");
});

test("where both totalEquity and shareholdersFunds are landed, totalEquity is the one tested", () => {
  const mk = (metric: string, value: number): Fact => ({
    id: `${metric}.${PK}`, metric, label: metric, period: PK, kind: "currency", value, unit: "GBP", rung: "R1",
    provenance: { sourceId: "x", tag: "Acc", documentName: "", locator: "", snippet: "", retrievedAt: "", contentHash: "" },
    verification: { status: "SINGLE_SOURCE", checks: [] },
  });
  const facts: Record<string, Fact> = {
    [`netAssets.${PK}`]: mk("netAssets", 500),
    [`totalEquity.${PK}`]: mk("totalEquity", 500),
    [`shareholdersFunds.${PK}`]: mk("shareholdersFunds", 900),
  };
  const checks = runStructuralChecks(facts, PK);
  assert(checks.find((c) => c.id === `net-assets.${PK}`)?.passed, "ties against totalEquity");
  assertEqual(facts[`shareholdersFunds.${PK}`].verification.checks.length, 0, "shareholdersFunds untouched");
});

suite("BE identities live / trading account on iXBRL");

test("CostSales and GrossProfitLoss are read, and turnover - cost of sales = gross profit ties", () => {
  const m = build(filing([
    fig("TurnoverRevenue", "c0", "378,465"),
    fig("CostSales", "c0", "222,938"),
    fig("GrossProfitLoss", "c0", "155,527"),
  ]));
  assertEqual(m.facts[`costOfSales.${PK}`].value, 222_938_000, "cost of sales, tagged positive");
  assertEqual(m.facts[`grossProfit.${PK}`].value, 155_527_000, "gross profit");
  const c = checkOn(m, `grossProfit.${PK}`, "gross-profit");
  assert(c?.passed, "the trading-account identity ran and passed");
  for (const k of ["turnover", "costOfSales", "grossProfit"]) {
    assertEqual(m.facts[`${k}.${PK}`].verification.status, "STRUCTURAL_PASS", `${k} upgraded`);
  }
});

test("a broken trading account fails", () => {
  const m = build(filing([
    fig("TurnoverRevenue", "c0", "378,465"),
    fig("CostSales", "c0", "222,938"),
    fig("GrossProfitLoss", "c0", "165,527"),
  ]));
  const c = checkOn(m, `grossProfit.${PK}`, "gross-profit");
  assert(c && !c.passed, "gross profit out by 10,000 fails");
  assertEqual(m.facts[`turnover.${PK}`].verification.status, "STRUCTURAL_FAIL", "turnover flagged with it");
});

suite("BE identities live / working capital from dimensioned creditors");

test("Creditors on the current and within-one-year members is read, and the working-capital identity ties", () => {
  const m = build(filing([
    fig("CurrentAssets", "c2", "14,090"),
    fig("Creditors", "c350", "84,885"),
    fig("Creditors", "c351", "70,052"),
    fig("Creditors", "c326", "84,885"),
    fig("NetCurrentAssetsLiabilities", "c2", "70,795", "-"),
  ]));
  assertEqual(m.facts[`creditorsWithinOneYear.${PK}`].value, 84_885_000, "the current year, not the 70,052 comparative");
  const c = checkOn(m, `netCurrentAssets.${PK}`, "net-current-assets");
  assert(c?.passed, "14,090 - 84,885 = (70,795) ties");
  assertEqual(m.facts[`creditorsWithinOneYear.${PK}`].verification.status, "STRUCTURAL_PASS", "creditors upgraded");
});

test("a broken working-capital tie fails", () => {
  const m = build(filing([
    fig("CurrentAssets", "c2", "14,090"),
    fig("Creditors", "c350", "84,885"),
    fig("NetCurrentAssetsLiabilities", "c2", "60,795", "-"),
  ]));
  const c = checkOn(m, `netCurrentAssets.${PK}`, "net-current-assets");
  assert(c && !c.passed, "out by 10,000 fails");
  assertEqual(m.facts[`currentAssets.${PK}`].verification.status, "STRUCTURAL_FAIL", "current assets flagged");
});

test("a creditors row on any other axis (trade creditors) is never read as the total", () => {
  const ex = extractFinancials(filing([fig("Creditors", "c900", "12,000"), fig("CurrentAssets", "c2", "14,090")]))!;
  assert(!ex.lines.some((l) => l.metric === "creditorsWithinOneYear"), "the split abstains");
});

test("two within-one-year contexts that disagree abstain rather than choose", () => {
  const ex = extractFinancials(filing([fig("Creditors", "c350", "84,885"), fig("Creditors", "c326", "84,000"), fig("CurrentAssets", "c2", "1")]))!;
  assert(!ex.lines.some((l) => l.metric === "creditorsWithinOneYear"), "no line when they disagree");
});

test("Creditors on the non-current and after-one-year members lands as creditors after one year", () => {
  const ex = extractFinancials(filing([fig("Creditors", "c354", "144,931"), fig("Creditors", "c350", "84,885")]))!;
  assertEqual(ex.lines.find((l) => l.metric === "creditorsAfterOneYear")?.value, 144_931_000, "after one year");
  assertEqual(ex.lines.find((l) => l.metric === "creditorsWithinOneYear")?.value, 84_885_000, "within one year kept apart");
});

suite("BE identities live / gold filing 03454787");

test("on the real filing the net-assets, trading-account and working-capital identities all run and pass", () => {
  const xml = readFileSync(join(HERE, "../eval/gold/fixtures/uk/03454787-2025-12-31/filing.xhtml"), "utf8");
  const m = build(xml);
  for (const [fact, check] of [
    [`netAssets.${PK}`, "net-assets"],
    [`grossProfit.${PK}`, "gross-profit"],
    [`netCurrentAssets.${PK}`, "net-current-assets"],
  ]) {
    const c = checkOn(m, fact, check);
    assert(c, `${check} ran on 03454787`);
    assert(c!.passed, `${check} passed on 03454787: ${c!.detail}`);
  }
});
