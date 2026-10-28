// test/secEdgar.test.ts
// The SEC EDGAR mapping is pure (takes already-fetched JSON), so it tests offline with a
// small Company-Facts fixture shaped exactly like data.sec.gov. Confirms base lines land
// at R1 and the ladder synthesises EBITDA / net debt / leverage, with nothing invented.

import { suite, test, assert, assertEqual } from "./harness";
import {
  extractEdgarFinancials,
  mapEdgarToManifest,
  type CompanyFacts,
  type Submissions,
} from "../lib/sources/secEdgar";

// Clean synthetic values (not a real filer): revenue 1000, operating profit 200, D&A 50,
// cash 80, long-term debt 300, current portion 40. So EBITDA = 250, net debt = 260,
// leverage = 260/250 = 1.04x.
const usd = (val: number) => ({
  units: { USD: [{ end: "2024-09-28", val, fy: 2024, fp: "FY", form: "10-K", accn: "0000320193-24-000123" }] },
});
const CF: CompanyFacts = {
  cik: 320193,
  entityName: "DEMO CORP",
  facts: {
    "us-gaap": {
      RevenueFromContractWithCustomerExcludingAssessedTax: usd(1000),
      OperatingIncomeLoss: usd(200),
      DepreciationDepletionAndAmortization: usd(50),
      CashAndCashEquivalentsAtCarryingValue: usd(80),
      LongTermDebtNoncurrent: usd(300),
      LongTermDebtCurrent: usd(40),
    },
  },
};
const SUB: Submissions = {
  cik: "320193",
  name: "DEMO CORP",
  sicDescription: "Electronic Computers",
  sic: "3571",
  stateOfIncorporation: "CA",
  fiscalYearEnd: "0928",
};

suite("secEdgar / extraction");

const fin = extractEdgarFinancials(CF)!;
const byMetric = (m: string) => fin.lines.find((l) => l.metric === m);

test("extracts the tagged base lines from Company Facts", () => {
  assert(fin !== null, "financials extracted");
  assertEqual(byMetric("turnover")?.value, 1000, "turnover from RevenueFromContract...");
  assertEqual(byMetric("operatingProfit")?.value, 200, "operating profit from OperatingIncomeLoss");
  assertEqual(byMetric("depreciationAmortisation")?.value, 50, "D&A tagged");
  assertEqual(byMetric("cash")?.value, 80, "cash tagged");
});

test("sums borrowings from long-term + current debt", () => {
  assertEqual(byMetric("borrowings")?.value, 340, "borrowings = 300 + 40");
});

test("base lines carry the us-gaap concept as provenance", () => {
  assert(byMetric("turnover")?.concept.startsWith("us-gaap:"), "concept namespaced");
});

suite("secEdgar / manifest + ladder");

const m = mapEdgarToManifest(SUB, CF);

test("base financial lines land at R1 with provenance", () => {
  const t = m.facts["turnover.FY2024"];
  assert(!!t && t.rung === "R1" && t.value === 1000, "turnover R1 = 1000");
  assert(!!t?.provenance, "turnover carries provenance");
});

test("the ladder synthesises EBITDA and net debt from the base lines", () => {
  assertEqual(m.facts["ebitda.FY2024"]?.value, 250, "EBITDA = operating profit + D&A");
  assertEqual(m.facts["netDebt.FY2024"]?.value, 260, "net debt = borrowings - cash");
  assert(!!m.facts["leverage.FY2024"], "leverage synthesised");
});

test("the entity is marked real (SEC registrant), not synthetic", () => {
  assertEqual(m.entity.synthetic, false, "real entity");
  assertEqual(m.entity.companyName, "DEMO CORP", "name carried");
  assert(m.entity.jurisdiction.includes("US"), "US jurisdiction");
});

test("no financial line is fabricated when its concept is absent", () => {
  const bare: CompanyFacts = { cik: 1, entityName: "BARE", facts: { "us-gaap": {} } };
  const bm = mapEdgarToManifest({ cik: "1", name: "BARE" }, bare);
  const anyFinancial = Object.values(bm.facts).some((f) =>
    ["turnover", "ebitda", "netDebt"].includes(f.metric),
  );
  assert(!anyFinancial, "no financial facts invented when nothing is tagged");
});

suite("secEdgar / mixed-period safety");

// The same concept pool, but the debt tag's latest annual fact is a YEAR OLDER than the P&L
// and cash. Each metric's latest annual is picked independently, so this is a real filing
// shape: leverage must NOT be computed across two fiscal years.
const usdAt = (val: number, end: string) => ({
  units: { USD: [{ end, val, fy: Number(end.slice(0, 4)), fp: "FY", form: "10-K", accn: "0000320193-24-000999" }] },
});
const MIXED: CompanyFacts = {
  cik: 320193,
  entityName: "MIXED CORP",
  facts: {
    "us-gaap": {
      RevenueFromContractWithCustomerExcludingAssessedTax: usdAt(1000, "2024-09-28"),
      OperatingIncomeLoss: usdAt(200, "2024-09-28"),
      DepreciationDepletionAndAmortization: usdAt(50, "2024-09-28"),
      CashAndCashEquivalentsAtCarryingValue: usdAt(80, "2024-09-28"),
      LongTermDebtNoncurrent: usdAt(300, "2023-09-30"), // a year older than the rest
    },
  },
};
const mm = mapEdgarToManifest({ cik: "320193", name: "MIXED CORP" }, MIXED);

test("a base line from an older year lands under its own period, never the latest key", () => {
  assertEqual(mm.facts["borrowings.FY2023"]?.value, 300, "older debt keyed under FY2023");
  assert(!mm.facts["borrowings.FY2024"], "the older debt does not appear under FY2024");
  assertEqual(mm.facts["turnover.FY2024"]?.value, 1000, "same-year P&L stays under FY2024");
});

test("leverage abstains rather than mixing debt and EBITDA from different years", () => {
  const lev = mm.facts["leverage.FY2024"];
  assert(!lev || lev.rung === "R4" || lev.value === null, "no cross-year leverage ratio is synthesised");
  const nd = mm.facts["netDebt.FY2024"];
  assert(!nd || nd.rung === "R4" || nd.value === null, "net debt abstains without same-year borrowings");
});

test("borrowings never sums long-term and current debt across different years", () => {
  const splitYears: CompanyFacts = {
    cik: 7, entityName: "SPLIT",
    facts: { "us-gaap": {
      LongTermDebtNoncurrent: usdAt(300, "2024-09-28"),
      LongTermDebtCurrent: usdAt(40, "2023-09-30"), // different year -> must not be added
    } },
  };
  const fin2 = extractEdgarFinancials(splitYears)!;
  assertEqual(fin2.lines.find((l) => l.metric === "borrowings")?.value, 300, "current portion from another year is dropped, not summed");
});

suite("secEdgar / as-reported date (restatement precedence)");

test("the manifest carries the filing (as-reported) date so a restatement can supersede an original", () => {
  const filed = (val: number, end: string, filedAt: string) => ({
    units: { USD: [{ end, val, fy: Number(end.slice(0, 4)), fp: "FY", form: "10-K", accn: "0000320193-24-000123", filed: filedAt }] },
  });
  const cf: CompanyFacts = {
    cik: 320193, entityName: "FILED CORP",
    facts: { "us-gaap": {
      RevenueFromContractWithCustomerExcludingAssessedTax: filed(1000, "2024-09-28", "2024-11-01"),
      OperatingIncomeLoss: filed(200, "2024-09-28", "2024-11-01"),
    } },
  };
  const mf = mapEdgarToManifest({ cik: "320193", name: "FILED CORP" }, cf);
  assertEqual(mf.entity.asReportedAt, "2024-11-01", "as-reported date is the filing date, not the capture time");
});

suite("secEdgar / verification gate");

test("clean figures pass the scale/sign checks (relative tolerance holds on large numbers)", () => {
  const to = m.facts["turnover.FY2024"];
  const scale = to.verification.checks.find((c) => c.identity.includes("operating profit"));
  assert(!!scale && scale.passed, "operating profit <= turnover passes");
  assert(m.facts["cash.FY2024"].verification.checks.some((c) => c.passed), "cash sign check present");
});

test("a scale-error (operating profit > turnover) is flagged STRUCTURAL_FAIL, not shown clean", () => {
  // Same fixture but operating profit misread 1,000x (200000 vs turnover 1000).
  const broken: CompanyFacts = {
    cik: 9,
    entityName: "SCALE ERR",
    facts: {
      "us-gaap": {
        RevenueFromContractWithCustomerExcludingAssessedTax: usd(1000),
        OperatingIncomeLoss: usd(200000),
      },
    },
  };
  const bm = mapEdgarToManifest({ cik: "9", name: "SCALE ERR" }, broken);
  assertEqual(
    bm.facts["operatingProfit.FY2024"].verification.status,
    "STRUCTURAL_FAIL",
    "scale error is surfaced, never presented as clean",
  );
});
