// eval/gold/us.ts
// A REAL gold set: frozen, trimmed snapshots of live SEC Company Facts (eval/gold/fixtures/*.json)
// with expected pipeline output. turnover and operatingProfit are hand-verified against the cited
// 10-K accession; the rest are frozen real magnitudes (regression + no-fabrication baseline). An
// ABSTAIN entry is a metric genuinely not derivable from the filing (e.g. Microsoft does not tag
// depreciation & amortisation, so EBITDA is proxied and D&A itself abstains). Regenerate with
// eval/gold/generate.ts after a deliberate snapshot refresh.
//
// CROSS-PERIOD ABSTENTIONS (the H5 fix): each metric's latest annual fact is picked
// independently, so a filer whose latest debt or interest tag is a YEAR OR MORE older than its
// latest P&L would otherwise have a derived metric computed across two fiscal years and presented
// as current. That is a period-mixed figure that never existed on one statement, so the pipeline
// now keys each base fact under its OWN fiscal year and abstains on any derived metric that would
// need a base fact from a different year. On these snapshots that means: Apple and Microsoft tag
// interest expense two years stale (FY2023 / FY2024) against a FY2025 / FY2026 P&L, so netInterest
// and interestCover abstain at the primary period; Coca-Cola's debt tags are all FY2023 against a
// FY2025 P&L, so borrowings, netDebt and leverage abstain. Leverage where the debt IS current
// (Apple 0.38x, Microsoft 0.12x) still resolves. This is honest abstention, not a recall leak.

export interface GoldCase {
  filer: string;
  cik: string;
  name: string;
  period: string;
  accession: string; // the 10-K the hand-verified figures were checked against
  expect: Record<string, number | "ABSTAIN">;
  verified: string[]; // metrics independently checked against the filing
}

export const US_GOLD: GoldCase[] = [
  {
    filer: "AAPL",
    cik: "0000320193",
    name: "Apple Inc.",
    period: "FY2025",
    accession: "0000320193-25-000079",
    expect: {
      turnover: 416_161_000_000,
      operatingProfit: 133_050_000_000,
      depreciationAmortisation: 11_698_000_000,
      cash: 35_934_000_000,
      borrowings: 90_678_000_000,
      netInterest: "ABSTAIN", // InterestExpense latest annual is FY2023, two years older than this FY2025 P&L
      ebitda: 144_748_000_000,
      netDebt: 54_744_000_000,
      leverage: 0.38, // debt IS current (FY2025), so leverage resolves
      interestCover: "ABSTAIN", // no same-period net interest to divide FY2025 EBITDA by
    },
    verified: ["turnover", "operatingProfit"],
  },
  {
    filer: "MSFT",
    cik: "0000789019",
    name: "Microsoft Corporation",
    period: "FY2026",
    accession: "0001193125-26-323660",
    expect: {
      turnover: 331_839_000_000,
      operatingProfit: 155_237_000_000,
      depreciationAmortisation: "ABSTAIN", // Microsoft does not tag D&A under our concepts
      cash: 20_935_000_000,
      borrowings: 40_294_000_000,
      netInterest: "ABSTAIN", // InterestExpense latest annual is FY2024, two years older than this FY2026 P&L
      netDebt: 19_359_000_000,
      leverage: 0.12, // debt IS current (FY2026), so leverage resolves
      interestCover: "ABSTAIN", // no same-period net interest to divide FY2026 EBITDA proxy by
    },
    verified: ["turnover", "operatingProfit"],
  },
  {
    filer: "KO",
    cik: "0000021344",
    name: "Coca-Cola Co",
    period: "FY2025",
    accession: "0001628280-26-010047",
    expect: {
      turnover: 47_941_000_000,
      operatingProfit: 13_762_000_000,
      depreciationAmortisation: 1_050_000_000,
      cash: 10_270_000_000,
      borrowings: "ABSTAIN", // all debt tags latest annual is FY2023, two years older than this FY2025 P&L
      netInterest: 1_654_000_000,
      ebitda: 14_812_000_000,
      netDebt: "ABSTAIN", // would subtract FY2025 cash from FY2023 debt: an aggregate that never existed
      leverage: "ABSTAIN", // no same-period net debt to divide FY2025 EBITDA by
      interestCover: 8.96, // net interest IS current (FY2025), so cover resolves
    },
    verified: ["turnover", "operatingProfit"],
  },
];
