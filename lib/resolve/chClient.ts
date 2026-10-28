// lib/resolve/chClient.ts
// The live ResolveClient. Search, profile and the LEI lookup reuse the existing functions in
// lib/sources by import. Accounts-category filing history with paging is not exported there,
// so a minimal fetcher lives here with the same base URL, Basic auth, budget guard, pacer and
// retry (lib/sources/chHttp.ts).

import { getProfile, searchCompanies } from "../sources/companiesHouseLive";
import { chFetchText } from "../sources/chHttp";
import { MB } from "../sources/fetchLimits";
import { resolveLei } from "../sources/gleif";
import type { ChFilingItem, ChProfile, ChSearchResult, ResolveClient } from "./types";

export type { ResolveClient } from "./types";

const CH_BASE = "https://api.company-information.service.gov.uk";
const PAGE_SIZE = 100;
// Three pages is 300 accounts filings, more than any company has. It bounds a bad response.
const MAX_PAGES = 3;

function authHeader(): string {
  const key = process.env.CH_API_KEY;
  if (!key) throw new Error("CH_API_KEY not set");
  return `Basic ${Buffer.from(`${key}:`).toString("base64")}`;
}

export async function fetchAccountsFilingHistory(number: string): Promise<ChFilingItem[]> {
  const header = authHeader();
  const items: ChFilingItem[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const path =
      `/company/${encodeURIComponent(number)}/filing-history` +
      `?category=accounts&items_per_page=${PAGE_SIZE}&start_index=${page * PAGE_SIZE}`;
    // Paced, budgeted and retried like every other CH JSON call (WP-BE14).
    const res = await chFetchText(`${CH_BASE}${path}`, {
      headers: { Authorization: header },
      accept: "application/json",
      maxBytes: 8 * MB,
      timeoutMs: 20_000,
    });
    // A company with no filings answers 404. That is an empty history, not an error.
    if (res.status === 404) return items;
    if (res.status === 401 || res.status === 403) {
      throw new Error("Companies House: authentication failed. Check CH_API_KEY.");
    }
    if (res.status === 429) throw new Error("Companies House: rate limit exceeded (600 requests / 5 min).");
    if (!res.ok) throw new Error(`Companies House: unexpected status ${res.status} for ${path}`);
    const body = JSON.parse(res.text) as { items?: ChFilingItem[]; total_count?: number };
    const got = body.items ?? [];
    items.push(...got);
    if (got.length < PAGE_SIZE || items.length >= (body.total_count ?? 0)) break;
  }
  return items;
}

export function createResolveClient(opts: { gleifFetch?: typeof fetch } = {}): ResolveClient {
  return {
    async search(q) {
      return (await searchCompanies(q)) as unknown as ChSearchResult;
    },
    async profile(number) {
      try {
        return (await getProfile(number)) as unknown as ChProfile;
      } catch (err) {
        if (err instanceof Error && /not found/i.test(err.message)) return null;
        throw err;
      }
    },
    filingHistory: fetchAccountsFilingHistory,
    async leiForCompanyNumber(number) {
      const rec = await resolveLei(number, { chNumber: number, fetchImpl: opts.gleifFetch });
      return rec?.lei ?? null;
    },
  };
}
