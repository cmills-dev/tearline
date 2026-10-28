// test/ixbrl.test.ts
// The deterministic iXBRL reader, and the end-to-end path where its base lines flow
// through the live Companies House mapper and the resolution ladder synthesises the
// derived metrics. The sample below mirrors the structure of a real FRC-taxonomy
// full-filer accounts document (current + prior contexts, GBP unit, tagged nonFraction
// facts). Validate against a genuine filing once CH_API_KEY is set.

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { suite, test, assert, assertEqual } from "./harness";
import { extractFinancials, parseIxbrl } from "../lib/sources/ixbrl";
import { mapLiveToManifest } from "../lib/sources/companiesHouseLive";
import type { CompanyProfile } from "../lib/sources/companiesHouse";
import type { ChargesList } from "../lib/sources/companiesHouse";

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"
      xmlns:ix="http://www.xbrl.org/2013/inlineXBRL"
      xmlns:xbrli="http://www.xbrl.org/2003/instance"
      xmlns:core="http://xbrl.frc.org.uk/fr/2023-01-01/core"
      xmlns:iso4217="http://www.xbrl.org/2003/iso4217"
      xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<head><title>PROJECT SAMPLE LIMITED - Annual accounts</title></head>
<body>
<ix:header><ix:resources>
  <xbrli:context id="c-2024"><xbrli:entity><xbrli:identifier scheme="http://www.companieshouse.gov.uk/">12345678</xbrli:identifier></xbrli:entity><xbrli:period><xbrli:startDate>2023-04-01</xbrli:startDate><xbrli:endDate>2024-03-31</xbrli:endDate></xbrli:period></xbrli:context>
  <xbrli:context id="c-2023"><xbrli:entity><xbrli:identifier scheme="http://www.companieshouse.gov.uk/">12345678</xbrli:identifier></xbrli:entity><xbrli:period><xbrli:startDate>2022-04-01</xbrli:startDate><xbrli:endDate>2023-03-31</xbrli:endDate></xbrli:period></xbrli:context>
  <xbrli:context id="i-2024"><xbrli:period><xbrli:instant>2024-03-31</xbrli:instant></xbrli:period></xbrli:context>
  <xbrli:context id="i-2023"><xbrli:period><xbrli:instant>2023-03-31</xbrli:instant></xbrli:period></xbrli:context>
  <xbrli:unit id="GBP"><xbrli:measure>iso4217:GBP</xbrli:measure></xbrli:unit>
</ix:resources></ix:header>
<table>
  <tr><td>Turnover</td>
    <td><ix:nonFraction name="core:TurnoverRevenue" contextRef="c-2024" unitRef="GBP" decimals="0">12,500,000</ix:nonFraction></td>
    <td><ix:nonFraction name="core:TurnoverRevenue" contextRef="c-2023" unitRef="GBP" decimals="0">11,000,000</ix:nonFraction></td></tr>
  <tr><td>Operating profit</td>
    <td><ix:nonFraction name="core:OperatingProfitLoss" contextRef="c-2024" unitRef="GBP" decimals="0">1,800,000</ix:nonFraction></td></tr>
  <tr><td>Depreciation</td>
    <td><ix:nonFraction name="core:DepreciationExpense" contextRef="c-2024" unitRef="GBP" decimals="0">600,000</ix:nonFraction></td></tr>
  <tr><td>Amortisation</td>
    <td><ix:nonFraction name="core:AmortisationExpense" contextRef="c-2024" unitRef="GBP" decimals="0">150,000</ix:nonFraction></td></tr>
  <tr><td>Interest payable</td>
    <td><ix:nonFraction name="core:InterestPayableSimilarCharges" contextRef="c-2024" unitRef="GBP" decimals="0">260,000</ix:nonFraction></td></tr>
  <tr><td>Cash at bank</td>
    <td><ix:nonFraction name="core:CashBankOnHand" contextRef="i-2024" unitRef="GBP" decimals="0">900,000</ix:nonFraction></td></tr>
  <tr><td>Bank borrowings</td>
    <td><ix:nonFraction name="core:BankBorrowings" contextRef="i-2024" unitRef="GBP" decimals="0">5,000,000</ix:nonFraction></td></tr>
  <tr><td>Directors (not a monetary fact, must be ignored)</td>
    <td><ix:nonFraction name="core:AverageNumberEmployeesDuringPeriod" contextRef="c-2024" decimals="0">42</ix:nonFraction></td></tr>
</table>
</body></html>`;

function profile(): CompanyProfile {
  return {
    company_name: "PROJECT SAMPLE LIMITED",
    company_number: "12345678",
    company_status: "active",
    date_of_creation: "2010-01-01",
    type: "ltd",
    jurisdiction: "england-wales",
    sic_codes: ["46390"],
    registered_office_address: { country: "United Kingdom" },
    accounts: { last_accounts: { made_up_to: "2024-03-31", type: "full" } },
  } as CompanyProfile;
}

const noCharges: ChargesList = { items: [], total_count: 0 };

suite("ixbrl / parse");

test("parses tagged nonFraction facts, contexts and the GBP unit", () => {
  const parsed = parseIxbrl(SAMPLE);
  assert(parsed.facts.length >= 8, "reads all tagged facts");
  assertEqual(parsed.units["GBP"].measure, "iso4217:GBP", "reads the currency unit");
  assertEqual(parsed.contexts["c-2024"].endDate, "2024-03-31", "reads the duration end date");
  assertEqual(parsed.contexts["i-2024"].instant, "2024-03-31", "reads the instant date");
});

test("applies thousands separators to values", () => {
  const parsed = parseIxbrl(SAMPLE);
  const turnover = parsed.facts.find(
    (f) => f.concept === "TurnoverRevenue" && f.contextRef === "c-2024"
  );
  assertEqual(turnover?.value, 12500000, "12,500,000 parses to 12500000");
});

suite("ixbrl / extract base lines");

function line(metric: string) {
  const ex = extractFinancials(SAMPLE);
  return ex?.lines.find((l) => l.metric === metric);
}

test("turnover takes the latest period, not the prior comparative", () => {
  assertEqual(line("turnover")?.value, 12500000, "current-year turnover, not 11,000,000");
});

test("operating profit, cash, borrowings and net interest read at face value", () => {
  assertEqual(line("operatingProfit")?.value, 1800000, "operating profit");
  assertEqual(line("cash")?.value, 900000, "cash");
  assertEqual(line("borrowings")?.value, 5000000, "borrowings");
  assertEqual(line("netInterest")?.value, 260000, "net interest");
});

test("D&A sums tagged depreciation and amortisation, never estimates", () => {
  assertEqual(line("depreciationAmortisation")?.value, 750000, "600,000 + 150,000");
});

test("a non-monetary / unmapped tag is ignored, not guessed", () => {
  const ex = extractFinancials(SAMPLE);
  assert(
    !ex?.lines.some((l) => String(l.value) === "42"),
    "the employee-count tag does not become a financial line"
  );
});

test("a document with no recognised facts returns null (financials abstain)", () => {
  assertEqual(extractFinancials("<html><body>no xbrl here</body></html>"), null, "null on empty");
});

suite("ixbrl / end-to-end synthesis through the live mapper");

test("extracted base lines synthesise EBITDA, net debt, leverage and cover", () => {
  const ex = extractFinancials(SAMPLE)!;
  const m = mapLiveToManifest(profile(), noCharges, { extracted: ex });
  const pk = "FY2024";
  assertEqual(m.facts[`turnover.${pk}`].rung, "R1", "turnover is reported R1");
  assertEqual(m.facts[`turnover.${pk}`].value, 12500000, "turnover value");
  // EBITDA = operating profit 1,800,000 + D&A 750,000 = 2,550,000, synthesised (R2)
  assertEqual(m.facts[`ebitda.${pk}`].rung, "R2", "EBITDA is synthesised R2");
  assertEqual(m.facts[`ebitda.${pk}`].value, 2550000, "EBITDA value");
  // Net debt = borrowings 5,000,000 - cash 900,000 = 4,100,000 (R2)
  assertEqual(m.facts[`netDebt.${pk}`].value, 4100000, "net debt value");
  // Leverage = 4,100,000 / 2,550,000 = 1.61x (ladder rounds to 2dp)
  assertEqual(m.facts[`leverage.${pk}`].value, 1.61, "leverage value");
  assertEqual(m.facts[`leverage.${pk}`].rung, "R2", "leverage synthesised R2");
});

test("with no accounts document, every financial line abstains at R4", () => {
  const m = mapLiveToManifest(profile(), noCharges, undefined);
  const pk = "FY2024";
  for (const metric of ["turnover", "ebitda", "netDebt", "leverage", "interestCover"]) {
    assertEqual(m.facts[`${metric}.${pk}`].rung, "R4", `${metric} abstains without a document`);
  }
});

suite("ixbrl / filleted balance-sheet accounts (no P&L)");

// A filleted / micro balance sheet: assets, creditors, net assets, cash - but no P&L.
const FILLETED = [
  '<xbrli:context id="c1"><xbrli:entity><xbrli:identifier>00000001</xbrli:identifier></xbrli:entity><xbrli:period><xbrli:instant>2024-12-31</xbrli:instant></xbrli:period></xbrli:context>',
  '<xbrli:unit id="gbp"><xbrli:measure>iso4217:GBP</xbrli:measure></xbrli:unit>',
  '<ix:nonFraction name="core:NetAssetsLiabilities" contextRef="c1" unitRef="gbp" scale="0">250000</ix:nonFraction>',
  '<ix:nonFraction name="core:CurrentAssets" contextRef="c1" unitRef="gbp">180000</ix:nonFraction>',
  '<ix:nonFraction name="core:CreditorsDueWithinOneYear" contextRef="c1" unitRef="gbp">90000</ix:nonFraction>',
  '<ix:nonFraction name="core:NetCurrentAssetsLiabilities" contextRef="c1" unitRef="gbp">90000</ix:nonFraction>',
  '<ix:nonFraction name="core:CashBankOnHand" contextRef="c1" unitRef="gbp">40000</ix:nonFraction>',
].join("\n");

test("reads balance-sheet lines from a filleted filing (net assets, current assets, creditors, cash)", () => {
  const ex = extractFinancials(FILLETED)!;
  const v = (m: string) => ex.lines.find((l) => l.metric === m)?.value;
  assertEqual(v("netAssets"), 250000, "net assets");
  assertEqual(v("currentAssets"), 180000, "current assets");
  assertEqual(v("creditorsWithinOneYear"), 90000, "creditors within one year");
  assertEqual(v("cash"), 40000, "cash");
  assert(!ex.lines.some((l) => l.metric === "turnover"), "no turnover (filleted: no P&L)");
});

test("surfaces balance-sheet facts as R1 while the P&L abstains at R4", () => {
  const ex = extractFinancials(FILLETED)!;
  const m = mapLiveToManifest(profile(), noCharges, { extracted: ex });
  const pk = "FY2024";
  assertEqual(m.facts[`netAssets.${pk}`].rung, "R1", "net assets reported R1");
  assertEqual(m.facts[`turnover.${pk}`].rung, "R4", "turnover not disclosed (R4)");
  assertEqual(m.facts[`ebitda.${pk}`].rung, "R4", "EBITDA not disclosed (R4)");
  // working-capital identity ties and upgrades the balance-sheet facts
  assert(
    m.facts[`netCurrentAssets.${pk}`].verification.checks.some((c) => c.passed && c.identity.includes("net current assets")),
    "working-capital identity ran and passed",
  );
});

// --- M2: numeric FORMAT transform (continental comma-decimal must not parse ~1000x wrong) ---
suite("ixbrl / numeric format transform");

const CONTINENTAL = `<html xmlns:ix="i" xmlns:xbrli="x" xmlns:core="c" xmlns:iso4217="iso">
<xbrli:context id="c1"><xbrli:period><xbrli:startDate>2023-01-01</xbrli:startDate><xbrli:endDate>2024-12-31</xbrli:endDate></xbrli:period></xbrli:context>
<xbrli:unit id="EUR"><xbrli:measure>iso4217:EUR</xbrli:measure></xbrli:unit>
<ix:nonFraction name="core:Turnover" contextRef="c1" unitRef="EUR" format="ixt:numcommadecimal">1.234.567,89</ix:nonFraction>
<ix:nonFraction name="core:CashBankOnHand" contextRef="c1" unitRef="EUR" format="ixt2:numdotcomma">50.000,00</ix:nonFraction>
</html>`;

test("a comma-decimal format is parsed correctly, not 1000x wrong", () => {
  const parsed = parseIxbrl(CONTINENTAL);
  const turnover = parsed.facts.find((f) => f.concept.toLowerCase() === "turnover");
  assertEqual(turnover?.value, 1234567.89, "1.234.567,89 -> 1234567.89 (comma is the decimal)");
  const cash = parsed.facts.find((f) => f.concept.toLowerCase() === "cashbankonhand");
  assertEqual(cash?.value, 50000, "50.000,00 -> 50000, not 50 or 50000.00 mis-scaled");
});

test("a dot-decimal (default UK) format still parses commas as thousands", () => {
  const uk = `<html xmlns:ix="i" xmlns:xbrli="x" xmlns:core="c">
  <xbrli:context id="c1"><xbrli:period><xbrli:endDate>2024-12-31</xbrli:endDate></xbrli:period></xbrli:context>
  <ix:nonFraction name="core:Turnover" contextRef="c1" format="ixt:numdotdecimal">1,234,567.89</ix:nonFraction></html>`;
  const t = parseIxbrl(uk).facts.find((f) => f.concept.toLowerCase() === "turnover");
  assertEqual(t?.value, 1234567.89, "1,234,567.89 -> 1234567.89 (dot is the decimal)");
});

// --- M2: dimension-blindness (a segment fact must never beat the consolidated total) ---
suite("ixbrl / dimension exclusion");

const DIMENSIONED = `<html xmlns:ix="i" xmlns:xbrli="x" xmlns:core="c" xmlns:iso4217="iso">
<xbrli:context id="grp"><xbrli:period><xbrli:startDate>2023-01-01</xbrli:startDate><xbrli:endDate>2024-12-31</xbrli:endDate></xbrli:period></xbrli:context>
<xbrli:context id="seg"><xbrli:period><xbrli:startDate>2023-01-01</xbrli:startDate><xbrli:endDate>2024-12-31</xbrli:endDate></xbrli:period><xbrli:scenario><xbrldi:explicitMember dimension="core:SegmentsAxis">core:SegmentA</xbrldi:explicitMember></xbrli:scenario></xbrli:context>
<xbrli:unit id="GBP"><xbrli:measure>iso4217:GBP</xbrli:measure></xbrli:unit>
<ix:nonFraction name="core:Turnover" contextRef="grp" unitRef="GBP">10000000</ix:nonFraction>
<ix:nonFraction name="core:Turnover" contextRef="seg" unitRef="GBP">99999999</ix:nonFraction>
</html>`;

test("a dimensioned segment fact never beats the consolidated total", () => {
  const t = extractFinancials(DIMENSIONED)?.lines.find((l) => l.metric === "turnover");
  assertEqual(t?.value, 10000000, "the group total wins, not the larger segment figure");
});

test("a concept tagged ONLY dimensioned abstains rather than surfacing a non-total", () => {
  const segOnly = `<html xmlns:ix="i" xmlns:xbrli="x" xmlns:core="c" xmlns:iso4217="iso">
  <xbrli:context id="seg"><xbrli:period><xbrli:endDate>2024-12-31</xbrli:endDate></xbrli:period><xbrli:segment><xbrldi:explicitMember dimension="core:SegmentsAxis">core:SegmentA</xbrldi:explicitMember></xbrli:segment></xbrli:context>
  <xbrli:unit id="GBP"><xbrli:measure>iso4217:GBP</xbrli:measure></xbrli:unit>
  <ix:nonFraction name="core:Turnover" contextRef="seg" unitRef="GBP">5000000</ix:nonFraction></html>`;
  const ex = extractFinancials(segOnly);
  assert(!ex?.lines.some((l) => l.metric === "turnover"), "no turnover surfaced from a segment-only tag");
});

// --- WP-BE13: borrowings tagged only by maturity band (audit finding 9) ---
suite("ixbrl / borrowings tagged by maturity");

// A context carrying explicit maturity members, the way FRC filers tag the creditors notes.
const band = (id: string, members: string[], instant = "2025-12-31", typed = false) =>
  `<xbrli:context id="${id}"><xbrli:period><xbrli:instant>${instant}</xbrli:instant></xbrli:period><xbrli:segment>${members
    .map((m) => `<xbrldi:explicitMember dimension="${m.includes("Year") || m.includes("Five") ? "d:MaturitiesOrExpirationPeriodsDimension" : "d:FinancialInstrumentCurrentNon-currentDimension"}">d:${m}</xbrldi:explicitMember>`)
    .join("")}${typed ? `<xbrldi:typedMember dimension="d:FurtherItemCreditorsDimension"><d:item>1</d:item></xbrldi:typedMember>` : ""}</xbrli:segment></xbrli:context>`;
const fact = (name: string, ctx: string, v: string) => `<ix:nonFraction name="d:${name}" contextRef="${ctx}" unitRef="GBP" scale="3">${v}</ix:nonFraction>`;
const doc = (...parts: string[]) => `<html xmlns:ix="i" xmlns:xbrli="x" xmlns:xbrldi="xd" xmlns:d="d">
<xbrli:context id="i"><xbrli:period><xbrli:instant>2025-12-31</xbrli:instant></xbrli:period></xbrli:context>
<xbrli:unit id="GBP"><xbrli:measure>iso4217:GBP</xbrli:measure></xbrli:unit>
${band("cur", ["CurrentFinancialInstruments"])}${band("non", ["Non-currentFinancialInstruments"])}${band("w1", ["WithinOneYear"])}${band("a1", ["AfterOneYear"])}
${band("b15", ["BetweenOneFiveYears"])}${band("m5", ["MoreThanFiveYears"])}${band("curT", ["CurrentFinancialInstruments"], "2025-12-31", true)}
${fact("CashBankOnHand", "i", "100")}
${parts.join("\n")}</html>`;
const borrowingsOf = (xml: string) => extractFinancials(xml)?.lines.find((l) => l.metric === "borrowings");

test("loans tagged in both bands are added, and the sum names every tag", () => {
  const b = borrowingsOf(doc(fact("BankBorrowings", "w1", "1,000"), fact("BankBorrowings", "a1", "4,000"), fact("OtherRemainingBorrowings", "non", "500")));
  assertEqual(b?.value, 5_500_000, "1,000 + 4,000 + 500 (£000)");
  assert(/BankBorrowings\[within one year\]/.test(b!.concept) && /OtherRemainingBorrowings\[after more than one year\]/.test(b!.concept), `every tag is named: ${b?.concept}`);
});

test("the same loan tagged under two members of one band counts once", () => {
  const b = borrowingsOf(doc(fact("BankBorrowings", "w1", "1,000"), fact("BankBorrowings", "cur", "1,000"), fact("BankBorrowings", "a1", "4,000")));
  assertEqual(b?.value, 5_000_000, "not 6,000");
});

test("an undimensioned borrowings total wins over the bands", () => {
  const b = borrowingsOf(doc(fact("Borrowings", "i", "9,999"), fact("BankBorrowings", "a1", "4,000")));
  assertEqual(b?.value, 9_999_000, "the filer's own total");
});

test("finer bands (one to five years, more than five) alone are never totalled", () => {
  assertEqual(borrowingsOf(doc(fact("BankBorrowings", "b15", "3,000"), fact("BankBorrowings", "m5", "1,000"), fact("BankBorrowings", "w1", "1,000"))), undefined, "abstains");
});

test("one band only: the other is nil only when its creditors add up with no loan among them", () => {
  const proved = borrowingsOf(
    doc(fact("OtherRemainingBorrowings", "non", "16,123"), fact("TradeCreditorsTradePayables", "cur", "8,151"), fact("OtherCreditors", "cur", "849"), fact("Creditors", "cur", "9,000"), fact("Debtors", "cur", "5,000"))
  );
  assertEqual(proved?.value, 16_123_000, "the after-one-year loan alone");
  assert(/Nothing is tagged as a loan within one year/.test(proved?.note ?? ""), `the reason is on the line: ${proved?.note}`);
  const noTotal = borrowingsOf(doc(fact("OtherRemainingBorrowings", "non", "16,123"), fact("TradeCreditorsTradePayables", "cur", "8,151")));
  assertEqual(noTotal, undefined, "no creditors total within one year: abstain");
  const shortSum = borrowingsOf(doc(fact("OtherRemainingBorrowings", "non", "16,123"), fact("TradeCreditorsTradePayables", "cur", "8,151"), fact("Creditors", "cur", "9,000")));
  assertEqual(shortSum, undefined, "the items do not add up to the total: abstain");
  const unknown = borrowingsOf(
    doc(fact("OtherRemainingBorrowings", "non", "16,123"), fact("TradeCreditorsTradePayables", "cur", "8,151"), fact("ConvertibleDebt", "cur", "849"), fact("Creditors", "cur", "9,000"))
  );
  assertEqual(unknown, undefined, "a creditors item the list does not know might be a loan: abstain");
});

test("a filer's own creditors line passes the nil proof only when it is the lease liability", () => {
  const lease = fact("LeaseLiabilitiesCurrentLiability", "i", "849");
  const items = [fact("OtherRemainingBorrowings", "non", "16,123"), fact("TradeCreditorsTradePayables", "cur", "8,151"), fact("FurtherItemCreditorsComponentTotalCreditors", "curT", "849"), fact("Creditors", "cur", "9,000")];
  assertEqual(borrowingsOf(doc(...items, lease))?.value, 16_123_000, "the own line equals the current lease liability");
  assertEqual(borrowingsOf(doc(...items)), undefined, "an own line that is not the lease might be a loan: abstain");
});

test("leases and amounts owed to group undertakings are never borrowings", () => {
  const b = borrowingsOf(doc(fact("BankBorrowings", "w1", "1,000"), fact("BankBorrowings", "a1", "4,000"), fact("LeaseLiabilities", "a1", "7,000"), fact("AmountsOwedToGroupUndertakings", "w1", "2,000")));
  assertEqual(b?.value, 5_000_000, "bank loans only");
});

test("Busy Bees Nurseries (frozen filing): borrowings, net debt, EBITDA and leverage match the printed notes", () => {
  const xml = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "eval", "gold", "fixtures", "uk", "03454787-2025-12-31", "filing.xhtml"), "utf8");
  const ex = extractFinancials(xml)!;
  const m = mapLiveToManifest(
    { ...profile(), company_name: "BUSY BEES NURSERIES LIMITED", company_number: "03454787", accounts: { last_accounts: { made_up_to: "2025-12-31", type: "full" } } } as CompanyProfile,
    noCharges,
    { extracted: ex }
  );
  const pk = "FY2025";
  // Note 16 prints "Secured loans 16,123" after more than one year; note 15 prints no loan.
  assertEqual(m.facts[`borrowings.${pk}`].value, 16_123_000, "borrowings");
  assert(/within one year/.test(m.facts[`borrowings.${pk}`].provenance!.snippet), "the citation says why nothing is due within one year");
  assertEqual(m.facts[`netDebt.${pk}`].value, 13_789_000, "16,123 less cash 2,334");
  assertEqual(m.facts[`ebitda.${pk}`].value, 98_712_000, "82,803 + 15,858 + 51, the tagged D&A");
  assertEqual(m.facts[`ebitda.${pk}`].rung, "R2", "EBITDA is derived, no longer the operating-profit proxy");
  assertEqual(m.facts[`leverage.${pk}`].value, 0.14, "13,789 / 98,712");
});

test("the dormant second iXBRL filing has no borrowings, and borrowings abstain", () => {
  const xml = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "eval", "gold", "fixtures", "uk", "00861615-2025-12-31", "filing.xhtml"), "utf8");
  assertEqual(borrowingsOf(xml), undefined, "nothing is tagged, so nothing is shown");
});
