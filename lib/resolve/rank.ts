// lib/resolve/rank.ts
// Ranking rules for register candidates (audit findings 18 and 21). Pure functions only.
//
// Order of precedence, first difference wins:
//   1. A strong name match (exact, exact ignoring spaces, or a previous name) before a
//      candidate that merely contains every word of the name.
//   2. Still on the register before dissolved.
//   2a. (WP-BE14) Among companies still on the register, a known shell (last accounts
//      micro-entity or dormant) after one whose last accounts carry real figures. A name is
//      recycled when a business fails: the retailer WILKO LIMITED 00365335 became WL
//      REALISATIONS (2023) LIMITED on 6 Nov 2023 and a finance shell took the name the same
//      day. Being active says nothing about the business the name is known for; a shell's
//      micro-entity accounts do say it is not that business. A company type that files no
//      accounts here (a limited partnership) stays after a shell, as it was.
//   2b. Active before in liquidation, administration or similar.
//   3. A company type that files accounts at Companies House before one that does not.
//   4. Last accounts with real figures before micro-entity, dormant or none.
//   5. An accounts filing with a document before an unchecked one, before none.
//   6. Exact, then exact ignoring spaces, then previous name, then contains on the current
//      name, then contains on a previous name.
//   7. The register search's own order.
// Overseas registrations (FC, BR, SF, NF, OE and their company types) never rank at all.

import { isSubstantiveAccounts } from "./accountsType";
import { compactCore, splitLegalForm, type LegalForm } from "./normalise";
import { isOverseasNumber } from "./numbers";
import type { Candidate, MatchKind } from "./types";

export interface NameMatch {
  kind: MatchKind;
  previousName?: string;
}

// Compact containment ("PIZZAEXPRESS" inside "PIZZA EXPRESS RESTAURANTS") only for names long
// enough that a coincidence inside another word is unlikely.
const MIN_COMPACT_CONTAINS = 8;

function formsAgree(a: LegalForm | null, b: LegalForm | null): boolean {
  return !a || !b || a === b;
}

function containsAllWords(haystackCore: string, words: string[]): boolean {
  const have = new Set(haystackCore.split(" "));
  return words.every((w) => have.has(w));
}

// How a register name (and its previous names) matches the typed name, or null for no match.
export function matchName(query: string, currentName: string, previousNames: string[] = []): NameMatch | null {
  const q = splitLegalForm(query);
  if (!q.core) return null;
  const qCompact = q.core.replace(/ /g, "");
  const qWords = q.core.split(" ");

  const cur = splitLegalForm(currentName);
  if (cur.core === q.core && formsAgree(q.form, cur.form)) return { kind: "exact" };
  if (compactCore(currentName) === qCompact && formsAgree(q.form, cur.form)) return { kind: "compact" };

  const prev = previousNames.map((name) => ({ name, ...splitLegalForm(name) }));
  for (const p of prev) {
    if ((p.core === q.core || p.core.replace(/ /g, "") === qCompact) && formsAgree(q.form, p.form)) {
      return { kind: "previous-name", previousName: p.name };
    }
  }

  const compactContains = (core: string) =>
    qCompact.length >= MIN_COMPACT_CONTAINS && core.replace(/ /g, "").includes(qCompact);
  if (containsAllWords(cur.core, qWords) || compactContains(cur.core)) return { kind: "contains" };
  for (const p of prev) {
    if (containsAllWords(p.core, qWords) || compactContains(p.core)) return { kind: "contains", previousName: p.name };
  }
  return null;
}

export function isStrongMatch(kind: MatchKind | undefined): boolean {
  return kind === "exact" || kind === "compact" || kind === "previous-name";
}

const MATCH_ORDER: Record<MatchKind, number> = { exact: 0, compact: 1, "previous-name": 2, contains: 3 };

export function matchStrength(kind: MatchKind | undefined): number {
  return kind ? MATCH_ORDER[kind] : 0;
}

// 0 active, 1 still on the register but not trading normally, 2 gone.
const GONE = new Set(["dissolved", "removed", "closed", "converted-closed"]);
export function statusTier(status: string): 0 | 1 | 2 {
  if (status === "active") return 0;
  if (GONE.has(status)) return 2;
  return 1;
}

// Company types that deliver their own accounts to Companies House.
const FILES_ACCOUNTS = new Set([
  "ltd",
  "plc",
  "llp",
  "private-unlimited",
  "private-unlimited-nsc",
  "old-public-company",
  "private-limited-guarant-nsc",
  "private-limited-guarant-nsc-limited-exemption",
  "private-limited-shares-section-30-exemption",
  "european-public-limited-liability-company-se",
  "royal-charter",
  "unregistered-company",
  "northern-ireland",
  "northern-ireland-other",
  "assurance-company",
]);
export function filesAccounts(type: string): boolean {
  return FILES_ACCOUNTS.has(type);
}

const OVERSEAS_TYPES = new Set(["oversea-company", "uk-establishment", "registered-overseas-entity"]);
export function isOverseasRegistration(number: string, type: string | undefined): boolean {
  return isOverseasNumber(number) || (type !== undefined && OVERSEAS_TYPES.has(type));
}

// A known shell: the last accounts on the profile are micro-entity or dormant. Unknown (profile not
// read, or no accounts yet) is not a shell; it is only not yet shown to be substantive.
export function isKnownShell(c: Candidate): boolean {
  const t = c.lastAccounts?.type;
  return t === "micro-entity" || t === "dormant";
}

export function rankKey(c: Candidate, searchIndex: number): number[] {
  const tier = statusTier(c.status);
  return [
    c.match === "contains" ? 1 : 0,
    tier === 2 ? 1 : 0,
    // Still on the register: files accounts with figures, then a known shell, then a company
    // type that files no accounts here at all (which ranked after a shell before this key too).
    tier === 2 ? 0 : !filesAccounts(c.type) ? 2 : isKnownShell(c) ? 1 : 0,
    tier,
    filesAccounts(c.type) ? 0 : 1,
    c.lastAccounts && isSubstantiveAccounts(c.lastAccounts.type) ? 0 : 1,
    c.hasAccountsFiling === true ? 0 : c.hasAccountsFiling === null ? 1 : 2,
    matchStrength(c.match) + (c.match === "contains" && c.matchedPreviousName ? 1 : 0),
    searchIndex,
  ];
}

export function compareRankKeys(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
