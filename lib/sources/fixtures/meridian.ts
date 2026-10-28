// lib/sources/fixtures/meridian.ts
// PROJECT MERIDIAN (illustrative) - synthetic, data-rich borrower filing FULL
// accounts. Full P&L and balance sheet across two periods, so most derived metrics
// resolve at R1/R2 and structural checks pass. Belongs to no real entity.

import type { BorrowerFixture } from "./types";

const RETRIEVED = "2026-07-28";

export const meridian: BorrowerFixture = {
  key: "meridian",
  displayName: "PROJECT MERIDIAN (illustrative)",
  thesis:
    "Data-rich full-accounts filer. Most lines resolve at R1/R2 and the balance sheet identity checks out, so the sheet is clean.",
  profile: {
    company_name: "MERIDIAN INDUSTRIES (ILLUSTRATIVE) LIMITED",
    company_number: "SC000000",
    company_status: "active",
    date_of_creation: "2009-04-14",
    type: "ltd",
    jurisdiction: "scotland",
    sic_codes: ["28990", "46690"],
    registered_office_address: {
      address_line_1: "1 Prospect Quay",
      locality: "Glasgow",
      postal_code: "G1 0AA",
      country: "United Kingdom",
    },
    accounts: {
      accounting_reference_date: { day: "31", month: "12" },
      last_accounts: {
        made_up_to: "2024-12-31",
        period_start_on: "2024-01-01",
        period_end_on: "2024-12-31",
        type: "full",
      },
      next_due: "2025-09-30",
      overdue: false,
    },
    has_charges: true,
  },
  filingHistory: {
    total_count: 2,
    filing_history_status: "filing-history-available",
    items: [
      {
        transaction_id: "MERID-AA-2024",
        category: "accounts",
        type: "AA",
        description: "Full accounts made up to 31 December 2024",
        date: "2025-06-18",
        links: { document_metadata: "https://frontend-doc-api/illustrative/aa-2024" },
      },
      {
        transaction_id: "MERID-AA-2023",
        category: "accounts",
        type: "AA",
        description: "Full accounts made up to 31 December 2023",
        date: "2024-06-20",
        links: { document_metadata: "https://frontend-doc-api/illustrative/aa-2023" },
      },
    ],
  },
  charges: {
    total_count: 2,
    unfiled_count: 0,
    items: [
      {
        charge_number: 1,
        classification: { description: "Fixed and floating charge" },
        persons_entitled: [{ name: "Northbridge Credit Partners LLP (illustrative)" }],
        status: "outstanding",
        created_on: "2022-03-02",
        secured_details: {
          description: "Fixed and floating charge over the whole property and undertaking of the company.",
        },
      },
      {
        charge_number: 2,
        classification: { description: "Debenture" },
        persons_entitled: [{ name: "Northbridge Credit Partners LLP (illustrative)" }],
        status: "outstanding",
        created_on: "2022-03-02",
        secured_details: { description: "All monies debenture supporting the revolving facility." },
      },
    ],
  },
  sources: {
    "meridian-aa-2024": {
      sourceId: "meridian-aa-2024",
      tag: "Acc",
      documentName: "Full accounts, year ended 31 December 2024",
      retrievedAt: RETRIEVED,
      origin: "fixture (synthetic filing, Companies House shape)",
    },
    "meridian-aa-2023": {
      sourceId: "meridian-aa-2023",
      tag: "Acc",
      documentName: "Full accounts, year ended 31 December 2023",
      retrievedAt: RETRIEVED,
      origin: "fixture (synthetic filing, Companies House shape)",
    },
    "meridian-charges": {
      sourceId: "meridian-charges",
      tag: "NF",
      documentName: "Companies House charges register",
      retrievedAt: RETRIEVED,
      origin: "fixture (synthetic filing, Companies House shape)",
    },
  },
  periods: [
    { key: "FY2024", label: "Year ended 31 December 2024", end: "2024-12-31", isLatest: true },
    { key: "FY2023", label: "Year ended 31 December 2023", end: "2023-12-31", isLatest: false },
  ],
  capitalStructure: [
    {
      id: "meridian-facility-a",
      name: "Senior term loan (Facility A)",
      rank: "senior-secured",
      metric: "trancheTermLoan",
      security: "Fixed and floating charge over all assets",
      provider: "Northbridge Credit Partners LLP (illustrative)",
      isFulcrum: true,
    },
    {
      id: "meridian-rcf",
      name: "Revolving credit facility",
      rank: "rcf",
      metric: "trancheRcf",
      security: "All-monies debenture (pari passu with Facility A)",
      provider: "Northbridge Credit Partners LLP (illustrative)",
      isFulcrum: false,
    },
    {
      id: "meridian-equity",
      name: "Shareholders' funds",
      rank: "equity",
      metric: "totalEquity",
      security: "Residual",
      provider: "Founders and management (illustrative)",
      isFulcrum: false,
    },
  ],
  derivedMetrics: ["ebitda", "netDebt", "leverage", "interestCover"],
  reported: [
    // ---- FY2024 P&L ----
    r("turnover", "Turnover", "FY2024", 48_200_000, "meridian-aa-2024", "Profit and loss account, p.11", "Turnover 48,200 (£'000)"),
    r("costOfSales", "Cost of sales", "FY2024", 30_100_000, "meridian-aa-2024", "Profit and loss account, p.11", "Cost of sales (30,100) (£'000)"),
    r("grossProfit", "Gross profit", "FY2024", 18_100_000, "meridian-aa-2024", "Profit and loss account, p.11", "Gross profit 18,100 (£'000)"),
    r("operatingProfit", "Operating profit (EBIT)", "FY2024", 6_400_000, "meridian-aa-2024", "Profit and loss account, p.11", "Operating profit 6,400 (£'000)"),
    r("depreciationAmortisation", "Depreciation & amortisation", "FY2024", 2_300_000, "meridian-aa-2024", "Note 4 Operating profit, p.18", "charged after depreciation of tangible assets 1,900 and amortisation of intangibles 400 (£'000)"),
    r("netInterest", "Interest payable", "FY2024", 1_150_000, "meridian-aa-2024", "Note 6 Interest, p.19", "Interest payable and similar charges 1,150 (£'000)"),
    // ---- FY2024 balance sheet ----
    r("cash", "Cash at bank and in hand", "FY2024", 3_900_000, "meridian-aa-2024", "Balance sheet, p.12", "Cash at bank and in hand 3,900 (£'000)"),
    r("borrowings", "Total borrowings", "FY2024", 22_000_000, "meridian-aa-2024", "Note 12 Creditors, p.22", "Bank loans 16,000 and revolving facility drawn 6,000 (£'000)"),
    r("trancheTermLoan", "Senior term loan (Facility A)", "FY2024", 16_000_000, "meridian-aa-2024", "Note 12 Creditors, p.22", "Bank loans 16,000 (£'000)"),
    r("trancheRcf", "Revolving credit facility drawn", "FY2024", 6_000_000, "meridian-aa-2024", "Note 12 Creditors, p.22", "Revolving facility drawn 6,000 (£'000)"),
    r("totalAssets", "Total assets", "FY2024", 41_000_000, "meridian-aa-2024", "Balance sheet, p.12", "Total assets 41,000 (£'000)"),
    r("totalLiabilities", "Total liabilities", "FY2024", 28_600_000, "meridian-aa-2024", "Balance sheet, p.12", "Total liabilities 28,600 (£'000)"),
    r("totalEquity", "Total equity (shareholders' funds)", "FY2024", 12_400_000, "meridian-aa-2024", "Balance sheet, p.12", "Total equity 12,400 (£'000)"),
    r("netAssets", "Net assets", "FY2024", 12_400_000, "meridian-aa-2024", "Balance sheet, p.12", "Net assets 12,400 (£'000)"),
    // ---- FY2023 comparatives ----
    r("turnover", "Turnover", "FY2023", 43_800_000, "meridian-aa-2023", "Profit and loss account, p.11", "Turnover 43,800 (£'000)"),
    r("operatingProfit", "Operating profit (EBIT)", "FY2023", 5_200_000, "meridian-aa-2023", "Profit and loss account, p.11", "Operating profit 5,200 (£'000)"),
    r("depreciationAmortisation", "Depreciation & amortisation", "FY2023", 2_100_000, "meridian-aa-2023", "Note 4 Operating profit, p.17", "depreciation and amortisation 2,100 (£'000)"),
    r("netInterest", "Interest payable", "FY2023", 1_260_000, "meridian-aa-2023", "Note 6 Interest, p.18", "Interest payable and similar charges 1,260 (£'000)"),
    r("cash", "Cash at bank and in hand", "FY2023", 2_600_000, "meridian-aa-2023", "Balance sheet, p.12", "Cash at bank and in hand 2,600 (£'000)"),
    r("borrowings", "Total borrowings", "FY2023", 24_000_000, "meridian-aa-2023", "Note 12 Creditors, p.21", "Bank loans and revolving facility 24,000 (£'000)"),
  ],
};

// Helper: build a RawReportedFact with the shared retrieved date and [Acc] tag.
function r(
  metric: string,
  label: string,
  period: string,
  value: number,
  sourceId: string,
  locator: string,
  snippet: string
): BorrowerFixture["reported"][number] {
  const kind = metric.startsWith("tranche") || metric.includes("total") || metric.includes("net") || value > 1000
    ? "currency"
    : "currency";
  return {
    metric,
    label,
    period,
    kind: "currency",
    unit: "GBP",
    value,
    sourceId,
    tag: sourceId.includes("charges") ? "NF" : "Acc",
    documentName:
      sourceId === "meridian-aa-2024"
        ? "Full accounts, year ended 31 December 2024"
        : "Full accounts, year ended 31 December 2023",
    locator,
    snippet,
    retrievedAt: RETRIEVED,
  };
  void kind;
}
