// eval/extraction.ts
// The extraction eval harness. Per docs/extraction-strategy.md the metric that matters is
// PRECISION ON SURFACED FIGURES: target 100%, zero fabricated numbers. Abstention is a
// first-class outcome, scored in four cells:
//
//   correctly-surfaced   surfaced a figure that matches the gold value
//   correctly-abstained  gold says "not available" and the system abstained
//   wrongly-surfaced     surfaced where it should have abstained, OR surfaced a WRONG
//                        value  <-- the fabrication cell; MUST be zero
//   wrongly-abstained    gold has a value but the system abstained  <-- a recall leak
//
// A dropped-but-correct figure costs coverage; a surfaced-but-wrong figure costs trust.
// The harness exits non-zero if the fabrication cell is non-empty, so it can gate CI.
//
// Run: npx tsx eval/extraction.ts   (or: npm run eval)

import { buildManifest } from "../lib/engine/buildManifest";
import { meridian } from "../lib/sources/fixtures/meridian";
import { mapEdgarToManifest, type CompanyFacts, type Submissions } from "../lib/sources/secEdgar";
import { extractFinancialsFromText } from "../lib/sources/pdfAccounts";
import { applyDoctrineGuard, parseExtractions } from "../lib/llm/extract";

type Gold = number | "ABSTAIN";
interface Case {
  id: string;
  source: string;
  metric: string;
  expected: Gold;
  actual: () => number | null; // the system's answer; null = abstained
  tol?: number; // relative tolerance (default 0.5%)
}

// --- SEC fixture (hand-specified expected values) ---
const usd = (val: number) => ({
  units: { USD: [{ end: "2024-09-28", val, fy: 2024, fp: "FY", form: "10-K", accn: "0000320193-24-000123" }] },
});
const CF: CompanyFacts = {
  cik: 1,
  entityName: "DEMO",
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
const SUB: Submissions = { cik: "1", name: "DEMO", sicDescription: "X", sic: "1", stateOfIncorporation: "CA" };
const secM = mapEdgarToManifest(SUB, CF);
const sec = (metric: string) => {
  const f = secM.facts[`${metric}.FY2024`];
  return f && typeof f.value === "number" ? f.value : null;
};

// --- PDF text fixture (hand-specified expected values, in whole pounds after x1000) ---
const ACCOUNTS = [
  "Figures in £'000                 2024      2023",
  "Turnover                       152,300   148,100",
  "Operating profit                24,900    22,100",
  "Cash and cash equivalents       12,500     9,800",
  "Loans and borrowings            86,000    90,000",
].join("\n");
const pdfEx = extractFinancialsFromText(ACCOUNTS);
const pdf = (metric: string) => pdfEx?.lines.find((l) => l.metric === metric)?.value ?? null;
const pdfNoScale = extractFinancialsFromText(ACCOUNTS.replace("Figures in £'000", "Figures"));
const pdfScaleErr = extractFinancialsFromText("Figures in £'000\nTurnover 1,000 900\nOperating profit 200,000 190,000");

// --- LLM guard (a fabricated value whose digits are not in its quote must be dropped) ---
const DOC = "Revenue for the year was 152,300 thousand pounds. Operating profit was 24,900 thousand.";
const guardSurvivorValue = (json: string, metric: string): number | null => {
  const survivors = applyDoctrineGuard(parseExtractions(json), DOC);
  const s = survivors.find((e) => e.metric === metric);
  return s ? Number(s.valueText.replace(/[^0-9.]/g, "")) : null;
};

// --- Fixture pipeline (assembly must surface a reported fact faithfully) ---
const merM = buildManifest(meridian);
const merPeriod = meridian.periods[0].key;
const merReported = meridian.reported.slice(0, 3); // sample a few declared figures
const fixtureCases: Case[] = merReported.map((r) => ({
  id: `fixture surfaces reported ${r.metric}`,
  source: "fixture",
  metric: r.metric,
  expected: r.value,
  actual: () => {
    const f = merM.facts[`${r.metric}.${merPeriod}`];
    return f && typeof f.value === "number" ? f.value : null;
  },
}));

const cases: Case[] = [
  ...fixtureCases,
  // SEC (deterministic XBRL): reported + a ladder-derived figure
  { id: "sec turnover (R1)", source: "sec", metric: "turnover", expected: 1000, actual: () => sec("turnover") },
  { id: "sec ebitda (ladder)", source: "sec", metric: "ebitda", expected: 250, actual: () => sec("ebitda") },
  { id: "sec net debt (ladder)", source: "sec", metric: "netDebt", expected: 260, actual: () => sec("netDebt") },
  { id: "sec fabricates nothing untagged", source: "sec", metric: "interestCover", expected: "ABSTAIN", actual: () => sec("interestCover") },
  // PDF text layer: scaled current-year column
  { id: "pdf turnover (scaled)", source: "pdf", metric: "turnover", expected: 152_300_000, actual: () => pdf("turnover") },
  { id: "pdf operating profit (scaled)", source: "pdf", metric: "operatingProfit", expected: 24_900_000, actual: () => pdf("operatingProfit") },
  { id: "pdf abstains with no declared scale", source: "pdf", metric: "turnover", expected: "ABSTAIN", actual: () => pdfNoScale?.lines.find((l) => l.metric === "turnover")?.value ?? null },
  { id: "pdf abstains on scale mismatch", source: "pdf", metric: "operatingProfit", expected: "ABSTAIN", actual: () => pdfScaleErr?.lines.find((l) => l.metric === "operatingProfit")?.value ?? null },
  // LLM guard
  { id: "guard passes a grounded value", source: "guard", metric: "revenue", expected: 152300, actual: () => guardSurvivorValue(JSON.stringify({ extractions: [{ metric: "revenue", valueText: "152,300", sourceQuote: "Revenue for the year was 152,300 thousand pounds." }] }), "revenue") },
  { id: "guard drops a fabricated value (not in its quote)", source: "guard", metric: "ebitda", expected: "ABSTAIN", actual: () => guardSurvivorValue(JSON.stringify({ extractions: [{ metric: "ebitda", valueText: "99,900", sourceQuote: "Operating profit was 24,900 thousand." }] }), "ebitda") },
];

function within(a: number, b: number, tol: number): boolean {
  // The absolute floor must be SMALL, not 1: a floor of 1 let a ratio metric drift by +/-1 (a
  // leverage of 1.84 would pass at 2.84), which is a huge error for a ratio. 0.01 avoids
  // floating-point noise on large currency magnitudes while still catching a real ratio drift.
  return Math.abs(a - b) <= Math.max(0.01, Math.abs(b) * tol);
}

let correctlySurfaced = 0, correctlyAbstained = 0, wronglySurfaced = 0, wronglyAbstained = 0;
const fabrications: string[] = [];

for (const c of cases) {
  const got = c.actual();
  const tol = c.tol ?? 0.005;
  if (c.expected === "ABSTAIN") {
    if (got === null) correctlyAbstained++;
    else {
      wronglySurfaced++;
      fabrications.push(`${c.id}: surfaced ${got}, expected ABSTAIN`);
    }
  } else if (got === null) {
    wronglyAbstained++;
  } else if (within(got, c.expected, tol)) {
    correctlySurfaced++;
  } else {
    wronglySurfaced++;
    fabrications.push(`${c.id}: surfaced ${got}, expected ${c.expected}`);
  }
}

const surfaced = correctlySurfaced + wronglySurfaced;
const precision = surfaced ? correctlySurfaced / surfaced : 1;
const recall = correctlySurfaced + wronglyAbstained ? correctlySurfaced / (correctlySurfaced + wronglyAbstained) : 1;

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
console.log("\nExtraction eval  (docs/extraction-strategy.md)\n" + "=".repeat(48));
console.log(`cases                 ${cases.length}`);
console.log(`correctly-surfaced    ${correctlySurfaced}`);
console.log(`correctly-abstained   ${correctlyAbstained}`);
console.log(`wrongly-surfaced      ${wronglySurfaced}   <- fabrication cell (must be 0)`);
console.log(`wrongly-abstained     ${wronglyAbstained}   (recall leak)`);
console.log("-".repeat(48));
console.log(`PRECISION on surfaced ${pct(precision)}   (target 100%)`);
console.log(`recall                ${pct(recall)}`);
if (fabrications.length) {
  console.log("\nFABRICATIONS / WRONG VALUES:");
  for (const f of fabrications) console.log("  " + f);
}
console.log("");

// Gate: any fabricated / wrong surfaced value fails the eval.
process.exit(wronglySurfaced > 0 ? 1 : 0);
