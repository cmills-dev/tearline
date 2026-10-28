// lib/resolve/filings.ts
// Pick the accounts filing to read (audit finding 6).
//
// The newest accounts-category filing is often not accounts at all: an AA01 changes the
// accounting reference date and has no figures. The rule: consider only AA (accounts) and
// AAMD (amended accounts) that carry a document link, and take the one for the latest
// made-up date. When an AAMD amends the same period as an AA, the later filing wins.

import { labelForAccountsTypeKey, type AccountsTypeLabel } from "./accountsType";
import type { ChFilingItem, ResolveClient } from "./types";

export interface DocumentFormats {
  ixbrl: boolean;
  pdf: boolean;
}

export interface SelectedAccountsFiling {
  transactionId: string;
  type: "AA" | "AAMD";
  madeUpDate: string | null;
  filedOn: string;
  description: string;
  accountsType: AccountsTypeLabel;
  documentMetadataUrl: string;
  // Filing history does not say which formats a document offers. null until the document
  // metadata has been read; see documentFormats().
  formats: DocumentFormats | null;
}

const ACCOUNTS_TYPES = new Set(["AA", "AAMD"]);

// Accounts cannot be made up to a date after Companies House received them. The register
// holds keying errors of this kind (a legacy WL Realisations filing says 2073), so such a
// date is treated as unknown rather than trusted as the newest period.
function plausibleMadeUpDate(item: ChFilingItem): string | null {
  const d = item.description_values?.made_up_date;
  return d && (!item.date || d <= item.date) ? d : null;
}

// The period a filing covers, for ordering. Falls back to the filing date when the made-up
// date is missing or implausible.
function periodKey(item: ChFilingItem): string {
  return plausibleMadeUpDate(item) ?? item.date ?? "";
}

export function selectLatestAccountsFiling(
  items: ChFilingItem[],
  metadata?: { resources?: Record<string, unknown> } | null
): SelectedAccountsFiling | null {
  const eligible = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => ACCOUNTS_TYPES.has(item.type) && !!item.links?.document_metadata);
  if (eligible.length === 0) return null;

  eligible.sort((a, b) => {
    const ma = periodKey(a.item);
    const mb = periodKey(b.item);
    if (ma !== mb) return ma < mb ? 1 : -1;
    if (a.item.date !== b.item.date) return a.item.date < b.item.date ? 1 : -1;
    return a.index - b.index;
  });

  const best = eligible[0].item;
  return {
    transactionId: best.transaction_id,
    type: best.type as "AA" | "AAMD",
    madeUpDate: plausibleMadeUpDate(best),
    filedOn: best.date,
    description: best.description ?? "",
    accountsType: labelForAccountsTypeKey(best.description),
    documentMetadataUrl: best.links!.document_metadata!,
    formats: metadata ? documentFormats(metadata) : null,
  };
}

// Read the formats a document offers from its Document API metadata.
export function documentFormats(meta: { resources?: Record<string, unknown> }): DocumentFormats {
  const keys = Object.keys(meta.resources ?? {}).map((k) => k.toLowerCase());
  return {
    ixbrl: keys.some((k) => k.includes("xhtml")),
    pdf: keys.some((k) => k.includes("pdf")),
  };
}

// Convenience: read the filing history through the client and select from it.
export async function latestAccountsFiling(
  number: string,
  client: ResolveClient
): Promise<SelectedAccountsFiling | null> {
  return selectLatestAccountsFiling(await client.filingHistory(number));
}

export function hasAccountsFiling(items: ChFilingItem[]): boolean {
  return selectLatestAccountsFiling(items) !== null;
}
