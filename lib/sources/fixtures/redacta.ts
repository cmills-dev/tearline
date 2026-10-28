// lib/sources/fixtures/redacta.ts
// PROJECT ▮▮▮▮ (illustrative) - synthetic small company filing FILLETED accounts.
// Only the balance sheet and a thin note set are filed publicly, so turnover is not
// disclosed (forces R4 abstain) and EBITDA cannot be built (D&A not split, forces an
// R3 proxy). The ladder is visibly doing work here. Belongs to no real entity.

import type { BorrowerFixture } from "./types";

const RETRIEVED = "2026-07-28";
const SRC = "redacta-aa-2024";
const DOC = "Filleted accounts, year ended 31 March 2024";

export const redacta: BorrowerFixture = {
  key: "redacta",
  displayName: "PROJECT ▮▮▮▮ (illustrative)",
  redactedName: true,
  thesis:
    "Filleted small-company accounts. Turnover is not filed (R4 abstain) and EBITDA cannot be built from a split D&A (R3 proxy on EBIT). The ladder does visible work.",
  profile: {
    company_name: "REDACTA TRADING (ILLUSTRATIVE) LIMITED",
    company_number: "12000000",
    company_status: "active",
    date_of_creation: "2016-08-22",
    type: "ltd",
    jurisdiction: "england-wales",
    sic_codes: ["47910"],
    registered_office_address: {
      address_line_1: "Unit 7, Kiln Road Industrial Estate",
      locality: "Leeds",
      postal_code: "LS1 0AA",
      country: "United Kingdom",
    },
    accounts: {
      accounting_reference_date: { day: "31", month: "03" },
      last_accounts: {
        made_up_to: "2024-03-31",
        period_start_on: "2023-04-01",
        period_end_on: "2024-03-31",
        type: "small",
      },
      next_due: "2024-12-31",
      overdue: false,
    },
    has_charges: true,
  },
  filingHistory: {
    total_count: 1,
    filing_history_status: "filing-history-available",
    items: [
      {
        transaction_id: "REDACTA-AA-2024",
        category: "accounts",
        type: "AA",
        description: "Filleted accounts made up to 31 March 2024",
        date: "2024-11-30",
        links: { document_metadata: "https://frontend-doc-api/illustrative/redacta-aa-2024" },
      },
    ],
  },
  charges: {
    total_count: 1,
    unfiled_count: 0,
    items: [
      {
        charge_number: 1,
        classification: { description: "Fixed and floating charge" },
        persons_entitled: [{ name: "Kiln Road Asset Finance Ltd (illustrative)" }],
        status: "outstanding",
        created_on: "2021-05-11",
        secured_details: {
          description: "Fixed and floating charge over the property and undertaking of the company.",
        },
      },
    ],
  },
  sources: {
    [SRC]: {
      sourceId: SRC,
      tag: "Acc",
      documentName: DOC,
      retrievedAt: RETRIEVED,
      origin: "fixture (synthetic filleted filing, Companies House shape)",
    },
    "redacta-charges": {
      sourceId: "redacta-charges",
      tag: "NF",
      documentName: "Companies House charges register",
      retrievedAt: RETRIEVED,
      origin: "fixture (synthetic filing, Companies House shape)",
    },
  },
  periods: [
    { key: "FY2024", label: "Year ended 31 March 2024", end: "2024-03-31", isLatest: true },
  ],
  capitalStructure: [
    {
      id: "redacta-term",
      name: "Asset finance facility",
      rank: "senior-secured",
      metric: "borrowings",
      security: "Fixed and floating charge over all assets",
      provider: "Kiln Road Asset Finance Ltd (illustrative)",
      isFulcrum: true,
    },
    {
      id: "redacta-equity",
      name: "Shareholders' funds",
      rank: "equity",
      metric: "totalEquity",
      security: "Residual",
      provider: "Directors (illustrative)",
      isFulcrum: false,
    },
  ],
  derivedMetrics: ["ebitda", "netDebt", "leverage", "interestCover", "turnover"],
  reported: [
    // Balance sheet is filed (R1). P&L is NOT filed under the filleted exemption.
    fact("cash", "Cash at bank and in hand", 210_000, "Balance sheet, p.2", "Cash at bank and in hand 210 (£'000)"),
    fact("borrowings", "Total borrowings", 1_150_000, "Note 3 Creditors, p.4", "Bank loans and asset finance 1,150 (£'000)"),
    fact("totalAssets", "Total assets", 2_450_000, "Balance sheet, p.2", "Total assets 2,450 (£'000)"),
    fact("totalLiabilities", "Total liabilities", 1_780_000, "Balance sheet, p.2", "Total liabilities 1,780 (£'000)"),
    fact("totalEquity", "Total equity (shareholders' funds)", 670_000, "Balance sheet, p.2", "Shareholders' funds 670 (£'000)"),
    fact("netAssets", "Net assets", 670_000, "Balance sheet, p.2", "Net assets 670 (£'000)"),
    // Operating profit is disclosed in a single note, but D&A is NOT split out, so
    // EBITDA cannot be synthesised and must fall to an R3 proxy on EBIT.
    fact("operatingProfit", "Operating profit (EBIT)", 340_000, "Note 2 Operating profit, p.3", "Operating profit for the financial year 340 (£'000)"),
    // NOTE: no turnover fact (filleted), no depreciationAmortisation split, and no
    // net interest line. Those absences are what drive the ladder to R3 and R4.
  ],
};

function fact(
  metric: string,
  label: string,
  value: number,
  locator: string,
  snippet: string
): BorrowerFixture["reported"][number] {
  return {
    metric,
    label,
    period: "FY2024",
    kind: "currency",
    unit: "GBP",
    value,
    sourceId: SRC,
    tag: "Acc",
    documentName: DOC,
    locator,
    snippet,
    retrievedAt: RETRIEVED,
  };
}
