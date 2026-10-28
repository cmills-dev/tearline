// test/esef.test.ts
// ESEF extraction is pure (takes the xBRL-JSON doc), so it tests offline against a trimmed
// real Tesco UKSEF filing. Confirms consolidated totals are read, borrowings summed, and the
// ladder synthesises the derived metrics from real IFRS-tagged figures.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { suite, test, assert, assertEqual } from "./harness";
import { extractEsefFinancials, mapEsefToManifest, type EsefDoc } from "../lib/sources/esef";

const here = dirname(fileURLToPath(import.meta.url));
const TESCO = JSON.parse(readFileSync(join(here, "fixtures", "tesco_esef.json"), "utf8")) as EsefDoc;

suite("esef / extraction (real Tesco UKSEF)");

const ex = extractEsefFinancials(TESCO)!;
const v = (m: string) => ex.lines.find((l) => l.metric === m)?.value;

test("reads consolidated IFRS totals (revenue, operating profit, cash)", () => {
  assert(ex !== null, "extracted");
  assertEqual(v("turnover"), 73_712_000_000, "Tesco FY revenue GBP 73,712m");
  // the CLEAN consolidated total is statutory operating profit (2,985m), not the
  // "before adjusting items" member (3,194m) - we take the statutory figure.
  assertEqual(v("operatingProfit"), 2_985_000_000, "statutory operating profit GBP 2,985m");
  assertEqual(v("cash"), 2_515_000_000, "cash GBP 2,515m");
});

test("sums long-term + short-term borrowings", () => {
  assertEqual(v("borrowings"), 5_372_000_000 + 1_824_000_000, "borrowings = LT + ST");
});

test("ignores segment / adjusting-items dimensioned facts (consolidated only)", () => {
  // The revenue total appears both clean and with a company-extension member; we take the clean one.
  assert(v("turnover") === 73_712_000_000, "did not pick a dimensioned member");
});

suite("esef / manifest + ladder");

const m = mapEsefToManifest("2138002P5RNKC5W2JZ46", "TESCO PLC", "fxo-test", TESCO)!;
const pk = "FY2026";

test("base lines R1, ladder synthesises EBITDA / net debt / leverage", () => {
  assertEqual(m.facts[`turnover.${pk}`].rung, "R1", "revenue R1");
  assert(!!m.facts[`ebitda.${pk}`] && m.facts[`ebitda.${pk}`].value !== null, "EBITDA synthesised");
  const nd = m.facts[`netDebt.${pk}`];
  assertEqual(nd.value, 5_372_000_000 + 1_824_000_000 - 2_515_000_000, "net debt = borrowings - cash");
  assertEqual(m.entity.lei, "2138002P5RNKC5W2JZ46", "LEI carried on the entity");
});
