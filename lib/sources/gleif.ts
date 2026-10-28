// lib/sources/gleif.ts
// Legal Entity Identifier resolution via the free GLEIF API (no key). The LEI is the
// cross-source join key (Companies House <-> ESEF <-> market data) and the entity de-dupe
// key. Two paths, both abstain rather than mis-link (a wrong LEI silently corrupts every
// downstream fact):
//   - Deterministic: a Companies House number maps to exactly one LEI whose registration
//     authority is Companies House (RA000585). Accepted only on an unambiguous single hit.
//   - Name: scored fuzzy match with a hard country filter and strict abstain thresholds.
// Parent/ultimate-parent LEIs come from the relationship endpoints (404 = top of tree).

import { getCache } from "../cache/cache";
import { foldDiacritics } from "../resolve/normalise";

const BASE = "https://api.gleif.org/api/v1";
const ACCEPT = "application/vnd.api+json";
const CH_REG_AUTHORITY = "RA000585"; // UK Companies House
const TTL = 60 * 60 * 24 * 30; // 30 days
const LEGAL_FORMS = new Set([
  "LIMITED", "LTD", "PLC", "LLP", "LP", "INC", "INCORPORATED", "CORP", "CORPORATION",
  "COMPANY", "CO", "LLC", "GMBH", "AG", "SA", "SE", "NV", "BV", "OY", "AB", "AS", "SPA", "SRL", "PTY",
]);

export interface LeiRecord {
  lei: string;
  legalName: string;
  jurisdiction: string; // ISO country of the legal address
  status: string; // registration status, e.g. "ISSUED"
  parentLei?: string;
  ultimateParentLei?: string;
}

// Name normalisation: uppercase, fold diacritics (foldDiacritics, shared with the register
// matcher), strip punctuation, expand &, drop a leading "THE", and remove legal-form tokens so
// "The Acme Trading Co. Ltd" and "ACME TRADING" compare on their distinctive core.
export function normaliseName(s: string): string {
  const base = foldDiacritics(s)
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = base.split(" ").filter((t) => t && !LEGAL_FORMS.has(t));
  if (tokens[0] === "THE") tokens.shift();
  return tokens.join(" ");
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = curr;
  }
  return prev[n];
}

// Legal-form token -> a rough jurisdiction/class group. Used to PENALISE a match between two names
// whose legal forms conflict: the core is stripped for comparison, so "Acme Ltd" and "Acme Inc"
// both reduce to "ACME" and would otherwise score 1.0 - but a UK private company and a US corp are
// almost certainly different entities. A form present on only one side is no signal (not penalised).
const FORM_GROUP: Record<string, string> = {
  LIMITED: "uk", LTD: "uk", PLC: "uk", LLP: "uk",
  INC: "us", INCORPORATED: "us", CORP: "us", CORPORATION: "us", LLC: "us",
  GMBH: "de", AG: "de",
  SA: "fr", SE: "eu", SPA: "it", SRL: "it",
  NV: "nl", BV: "nl",
  OY: "fi", AB: "se", AS: "no", PTY: "au",
  // CO, COMPANY, LP: too generic to imply a jurisdiction, so left ungrouped (no penalty).
};
function legalFormGroup(rawName: string): string | null {
  const toks = foldDiacritics(rawName).toUpperCase().replace(/[^A-Z0-9 ]/g, " ").split(/\s+/);
  for (const t of toks) if (FORM_GROUP[t]) return FORM_GROUP[t];
  return null;
}

// Similarity in [0,1]: the better of token-set Jaccard and Levenshtein ratio, with a penalty when
// the two names carry CONFLICTING legal forms (see FORM_GROUP), so a stripped-core coincidence
// across jurisdictions cannot clear the 0.9 accept threshold.
export function nameScore(a: string, b: string): number {
  const na = normaliseName(a), nb = normaliseName(b);
  if (!na || !nb) return 0;
  const ga = legalFormGroup(a), gb = legalFormGroup(b);
  const formConflict = ga !== null && gb !== null && ga !== gb;
  const raw = na === nb
    ? 1
    : (() => {
        const sa = new Set(na.split(" ")), sb = new Set(nb.split(" "));
        let inter = 0;
        for (const t of sa) if (sb.has(t)) inter++;
        const jaccard = inter / (sa.size + sb.size - inter);
        const lev = 1 - levenshtein(na, nb) / Math.max(na.length, nb.length);
        return Math.max(jaccard, lev);
      })();
  return formConflict ? raw * 0.6 : raw;
}

interface GleifItem {
  id: string;
  attributes?: {
    entity?: {
      legalName?: { name?: string };
      legalAddress?: { country?: string };
      registeredAs?: string;
      registeredAt?: { id?: string };
    };
    registration?: { status?: string };
  };
}
interface GleifList {
  data?: GleifItem[];
  meta?: { pagination?: { total?: number } };
}

async function gleifGet<T>(path: string, cacheKey: string, doFetch: typeof fetch): Promise<T | null> {
  const cache = getCache();
  const cached = await cache.get<T>(cacheKey);
  if (cached) return cached;
  try {
    const res = await doFetch(`${BASE}${path}`, { headers: { Accept: ACCEPT } } as RequestInit);
    if (res.status === 404) return null;
    if (!res.ok) return null;
    const data = (await res.json()) as T;
    await cache.set(cacheKey, data, TTL);
    return data;
  } catch {
    return null;
  }
}

function toRecord(item: GleifItem): LeiRecord {
  const e = item.attributes?.entity;
  return {
    lei: item.id,
    legalName: e?.legalName?.name ?? "",
    jurisdiction: e?.legalAddress?.country ?? "",
    status: item.attributes?.registration?.status ?? "",
  };
}

async function relatedLei(lei: string, kind: "direct-parent" | "ultimate-parent", doFetch: typeof fetch): Promise<string | undefined> {
  const rec = await gleifGet<{ data?: GleifItem }>(`/lei-records/${lei}/${kind}`, `gleif:${kind}:${lei}`, doFetch);
  return rec?.data?.id;
}

export interface ResolveOptions {
  chNumber?: string; // Companies House number: enables the deterministic path
  country?: string; // ISO country for the hard filter on the name path (e.g. "GB")
  withParents?: boolean;
  fetchImpl?: typeof fetch; // injectable for tests
}

// Resolve a company to its LEI record, or null when there is no confident match.
export async function resolveLei(query: string, opts: ResolveOptions = {}): Promise<LeiRecord | null> {
  const doFetch = opts.fetchImpl ?? fetch;

  // Deterministic path: CH number -> the single Companies-House-registered LEI.
  if (opts.chNumber) {
    const ch = opts.chNumber.trim();
    const list = await gleifGet<GleifList>(
      `/lei-records?filter[entity.registeredAs]=${encodeURIComponent(ch)}&filter[entity.legalAddress.country]=GB`,
      `gleif:ch:${ch}`,
      doFetch,
    );
    const total = list?.meta?.pagination?.total ?? list?.data?.length ?? 0;
    const item = list?.data?.[0];
    if (total === 1 && item && item.attributes?.entity?.registeredAt?.id === CH_REG_AUTHORITY) {
      return finalise(toRecord(item), opts, doFetch);
    }
    // A CH number is meant to be THE deterministic key; anything but an unambiguous
    // Companies-House-registered single hit abstains rather than risk a fuzzy mis-link.
    return null;
  }

  // Name path: fuzzy match with a hard country filter and strict abstain thresholds.
  const country = opts.country ?? (opts.chNumber ? "GB" : undefined);
  const countryFilter = country ? `&filter[entity.legalAddress.country]=${country}` : "";
  const list = await gleifGet<GleifList>(
    `/lei-records?filter[entity.legalName]=${encodeURIComponent(query)}${countryFilter}&page[size]=10`,
    `gleif:name:${normaliseName(query)}:${country ?? "any"}`,
    doFetch,
  );
  const items = list?.data ?? [];
  if (items.length === 0) return null;

  const scored = items
    .map((it) => ({ it, score: nameScore(query, it.attributes?.entity?.legalName?.name ?? "") }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  const second = scored[1];
  // Abstain: weak best, or an ambiguous top-two, or an inactive-only match.
  if (best.score < 0.9) return null;
  if (second && best.score - second.score < 0.05) return null;
  if ((best.it.attributes?.registration?.status ?? "ISSUED") !== "ISSUED") return null;
  return finalise(toRecord(best.it), opts, doFetch);
}

async function finalise(rec: LeiRecord, opts: ResolveOptions, doFetch: typeof fetch): Promise<LeiRecord> {
  if (opts.withParents) {
    rec.parentLei = await relatedLei(rec.lei, "direct-parent", doFetch);
    rec.ultimateParentLei = await relatedLei(rec.lei, "ultimate-parent", doFetch);
  }
  return rec;
}
