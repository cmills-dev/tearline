// test/beUkFormatTies.test.ts
// BE UK format ties: a Companies Act format 1 balance sheet does not print total assets or total
// liabilities, so the balance-sheet identity never runs on a UK filing. The format's own subtotals
// tie instead, and each is now an identity: fixed assets + net current assets = total assets less
// current liabilities (tie 1), and total assets less current liabilities − creditors after one
// year − provisions = net assets (tie 2). Tie 2 runs only when the face proves its terms complete.

import { suite, test, assert, assertEqual } from "./harness";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { extractFinancials } from "../lib/sources/ixbrl";
import { mapLiveToManifest } from "../lib/sources/companiesHouseLive";
import type { CompanyProfile, ChargesList } from "../lib/sources/companiesHouse";
import type { FactManifest } from "../lib/engine/types";

const HERE = dirname(fileURLToPath(import.meta.url));

function profile(): CompanyProfile {
  return {
    company_number: "03454787",
    company_name: "FORMAT SAMPLE LIMITED",
    company_status: "active",
    type: "ltd",
    date_of_creation: "1997-10-01",
    sic_codes: ["56101"],
    registered_office_address: { country: "United Kingdom" },
    accounts: { last_accounts: { made_up_to: "2025-12-31", type: "full" } },
  } as CompanyProfile;
}
const noCharges: ChargesList = { items: [], total_count: 0 };

// Contexts in the shape gold filing 03454787 uses.
const seg = (...members: [string, string][]) =>
  `<xbrli:segment>${members
    .map(([d, m]) => `<xbrldi:explicitMember dimension="d:${d}">d:${m}</xbrldi:explicitMember>`)
    .join("")}</xbrli:segment>`;
const ctx = (id: string, period: string, segment = "") =>
  `<xbrli:context id="${id}"><xbrli:entity><xbrli:identifier scheme="http://www.companieshouse.gov.uk/">03454787</xbrli:identifier>${segment}</xbrli:entity><xbrli:period>${period}</xbrli:period></xbrli:context>`;
const END = "<xbrli:instant>2025-12-31</xbrli:instant>";
const PRIOR = "<xbrli:instant>2024-12-31</xbrli:instant>";
const CUR = "FinancialInstrumentCurrentNon-currentDimension";
const MAT = "MaturitiesOrExpirationPeriodsDimension";

// A figure in £'000 the way the gold filing prints it: decimals -3, scale 3, comma thousands.
const fig = (name: string, context: string, text: string, sign = "") =>
  `<td><ix:nonFraction contextRef="${context}" decimals="-3" format="ixt:numcommadot" name="d:${name}" scale="3" unitRef="u0"${sign ? ` sign="${sign}"` : ""}>${text}</ix:nonFraction></td>`;
const row = (label: string, ...cells: string[]) => `<tr><td>${label}</td>${cells.join("")}</tr>`;

function filing(body: string[]): string {
  return [
    '<html xmlns:ix="http://www.xbrl.org/2013/inlineXBRL" xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:xbrldi="http://xbrl.org/2006/xbrldi" xmlns:d="http://xbrl.frc.org.uk/fr/2025-01-01/core"><body><ix:header><ix:resources>',
    ctx("c2", END),
    ctx("c3", PRIOR),
    ctx("c354", END, seg([CUR, "Non-currentFinancialInstruments"], [MAT, "AfterOneYear"])),
    ctx("c355", PRIOR, seg([CUR, "Non-currentFinancialInstruments"], [MAT, "AfterOneYear"])),
    '<xbrli:unit id="u0"><xbrli:measure>iso4217:GBP</xbrli:measure></xbrli:unit>',
    "</ix:resources></ix:header><table>",
    ...body,
    "</table></body></html>",
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

// The 03454787 face from total assets less current liabilities to net assets, both columns.
const TALCL = row("Total assets less current liabilities", fig("TotalAssetsLessCurrentLiabilities", "c2", "420,156"), fig("TotalAssetsLessCurrentLiabilities", "c3", "342,104"));
const CAO = row("Creditors: amounts falling due after more than one year 16", fig("Creditors", "c354", "144,931"), fig("Creditors", "c355", "139,587"));
const DEFTAX = row("Deferred taxation 17", fig("TaxationIncludingDeferredTaxationBalanceSheetSubtotal", "c2", "5,086"), fig("TaxationIncludingDeferredTaxationBalanceSheetSubtotal", "c3", "2,791"));
const NA = (text = "270,139") => row("Net assets", fig("NetAssetsLiabilities", "c2", text), fig("NetAssetsLiabilities", "c3", "199,726"));

suite("BE UK format ties / tie 1, fixed assets + net current assets = total assets less current liabilities");

test("the 03454787 figures tie and all three facts earn STRUCTURAL_PASS", () => {
  const m = build(filing([
    row("Fixed assets", fig("FixedAssets", "c2", "490,951")),
    row("Net current liabilities", fig("NetCurrentAssetsLiabilities", "c2", "70,795", "-")),
    TALCL,
  ]));
  const c = checkOn(m, `totalAssetsLessCurrentLiabilities.${PK}`, "uk-balance-sheet");
  assert(c, "the UK-format balance-sheet identity ran");
  assert(c!.passed, `490,951 + (70,795) = 420,156: ${c!.detail}`);
  assertEqual(c!.label, "Balance sheet (UK format) identity", "label");
  for (const k of ["fixedAssets", "netCurrentAssets", "totalAssetsLessCurrentLiabilities"]) {
    assertEqual(m.facts[`${k}.${PK}`].verification.status, "STRUCTURAL_PASS", `${k} upgraded`);
  }
});

test("a broken tie 1 fails and flags every term", () => {
  const m = build(filing([
    row("Fixed assets", fig("FixedAssets", "c2", "490,951")),
    row("Net current liabilities", fig("NetCurrentAssetsLiabilities", "c2", "60,795", "-")),
    TALCL,
  ]));
  const c = checkOn(m, `totalAssetsLessCurrentLiabilities.${PK}`, "uk-balance-sheet");
  assert(c && !c.passed, "out by 10,000 fails");
  for (const k of ["fixedAssets", "netCurrentAssets", "totalAssetsLessCurrentLiabilities"]) {
    assertEqual(m.facts[`${k}.${PK}`].verification.status, "STRUCTURAL_FAIL", `${k} flagged`);
  }
});

test("with no fixed assets tagged, tie 1 does not run", () => {
  const m = build(filing([row("Net current liabilities", fig("NetCurrentAssetsLiabilities", "c2", "70,795", "-")), TALCL]));
  assert(!checkOn(m, `totalAssetsLessCurrentLiabilities.${PK}`, "uk-balance-sheet"), "no check");
  assertEqual(m.facts[`totalAssetsLessCurrentLiabilities.${PK}`].verification.status, "SINGLE_SOURCE", "left single-source");
});

test("called up share capital not paid (format item A) is added, and no longer lands as share capital", () => {
  const m = build(filing([
    row("Called up share capital not paid", fig("CalledUpShareCapitalNotPaidNotExpressedAsCurrentAsset", "c2", "100")),
    row("Fixed assets", fig("FixedAssets", "c2", "400")),
    row("Net current assets", fig("NetCurrentAssetsLiabilities", "c2", "50")),
    row("Total assets less current liabilities", fig("TotalAssetsLessCurrentLiabilities", "c2", "550")),
  ]));
  const c = checkOn(m, `totalAssetsLessCurrentLiabilities.${PK}`, "uk-balance-sheet");
  assert(c?.passed, `100 + 400 + 50 = 550: ${c?.detail}`);
  assertEqual(m.facts[`shareCapitalNotPaid.${PK}`].verification.status, "STRUCTURAL_PASS", "item A upgraded");
  assert(!m.facts[`shareCapital.${PK}`], "the unpaid amount is not share capital");
});

suite("BE UK format ties / tie 2, total assets less current liabilities − creditors after one year − provisions = net assets");

test("the 03454787 face ties with deferred tax as the only provision, and all four facts earn STRUCTURAL_PASS", () => {
  const m = build(filing([TALCL, CAO, DEFTAX, NA()]));
  assertEqual(m.facts[`provisionsForLiabilities.${PK}`].value, 5_086_000, "deferred tax, the only line, is the provisions line");
  const c = checkOn(m, `netAssets.${PK}`, "uk-net-assets");
  assert(c, "the UK-format net-assets identity ran");
  assert(c!.passed, `420,156 − 144,931 − 5,086 = 270,139: ${c!.detail}`);
  for (const k of ["totalAssetsLessCurrentLiabilities", "creditorsAfterOneYear", "provisionsForLiabilities", "netAssets"]) {
    assertEqual(m.facts[`${k}.${PK}`].verification.status, "STRUCTURAL_PASS", `${k} upgraded`);
  }
});

test("a broken tie 2 fails and flags every term", () => {
  const m = build(filing([TALCL, CAO, DEFTAX, NA("275,139")]));
  const c = checkOn(m, `netAssets.${PK}`, "uk-net-assets");
  assert(c && !c.passed, "out by 5,000 fails");
  for (const k of ["totalAssetsLessCurrentLiabilities", "creditorsAfterOneYear", "provisionsForLiabilities", "netAssets"]) {
    assertEqual(m.facts[`${k}.${PK}`].verification.status, "STRUCTURAL_FAIL", `${k} flagged`);
  }
});

test("with no provisions line tagged, provisions do not land and tie 2 does not run", () => {
  const m = build(filing([TALCL, CAO, NA("275,225")]));
  assert(!m.facts[`provisionsForLiabilities.${PK}`], "no provisions fact");
  assert(!checkOn(m, `netAssets.${PK}`, "uk-net-assets"), "no check, so no false fail");
});

test("a net pension liability line below provisions stops tie 2 from running", () => {
  const m = build(filing([
    TALCL, CAO, DEFTAX,
    row("Net assets excluding pension liability", fig("NetAssetsLiabilitiesExcludingPensionAssetLiability", "c2", "270,139")),
    row("Pension liability", fig("DefinedBenefitPlanAssetLiability", "c2", "10,000", "-")),
    row("Net assets", fig("NetAssetsLiabilitiesIncludingPensionAssetLiability", "c2", "260,139")),
  ]));
  assert(!m.facts[`provisionsForLiabilities.${PK}`], "provisions cannot be proven the only term");
  assert(!checkOn(m, `netAssets.${PK}`, "uk-net-assets"), "tie 2 does not run");
});

test("a line printed with no tag between the subtotals stops tie 2 from running", () => {
  const m = build(filing([TALCL, CAO, DEFTAX, row("Accruals and deferred income", "<td>(1,200)</td>"), NA("268,939")]));
  assert(!m.facts[`provisionsForLiabilities.${PK}`], "an untagged figure means the terms are not proven complete");
  assert(!checkOn(m, `netAssets.${PK}`, "uk-net-assets"), "tie 2 does not run");
});

test("a provisions subtotal is the term when the filer tags one, with its components printed above it", () => {
  const m = build(filing([
    TALCL, CAO,
    row("Deferred taxation", fig("TaxationIncludingDeferredTaxationBalanceSheetSubtotal", "c2", "3,086")),
    row("Other provisions", fig("OtherProvisionsBalanceSheetSubtotal", "c2", "2,000")),
    row("Provisions for liabilities", fig("ProvisionsForLiabilitiesBalanceSheetSubtotal", "c2", "5,086")),
    NA(),
  ]));
  assertEqual(m.facts[`provisionsForLiabilities.${PK}`].value, 5_086_000, "the subtotal");
  assert(checkOn(m, `netAssets.${PK}`, "uk-net-assets")?.passed, "ties");
});

test("two provision components with no subtotal abstain rather than add them", () => {
  const m = build(filing([
    TALCL, CAO,
    row("Deferred taxation", fig("TaxationIncludingDeferredTaxationBalanceSheetSubtotal", "c2", "3,086")),
    row("Other provisions", fig("OtherProvisionsBalanceSheetSubtotal", "c2", "2,000")),
    NA(),
  ]));
  assert(!m.facts[`provisionsForLiabilities.${PK}`], "no provisions fact");
  assert(!checkOn(m, `netAssets.${PK}`, "uk-net-assets"), "tie 2 does not run");
});

suite("BE UK format ties / gold filing 03454787");

test("on the real filing both UK-format ties run and pass", () => {
  const xml = readFileSync(join(HERE, "../eval/gold/fixtures/uk/03454787-2025-12-31/filing.xhtml"), "utf8");
  const m = build(xml);
  assertEqual(m.facts[`provisionsForLiabilities.${PK}`]?.value, 5_086_000, "deferred taxation, 5,086");
  for (const [fact, check] of [
    [`totalAssetsLessCurrentLiabilities.${PK}`, "uk-balance-sheet"],
    [`netAssets.${PK}`, "uk-net-assets"],
  ]) {
    const c = checkOn(m, fact, check);
    assert(c, `${check} ran on 03454787`);
    assert(c!.passed, `${check} passed on 03454787: ${c!.detail}`);
  }
});
