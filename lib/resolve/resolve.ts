// lib/resolve/resolve.ts
// One resolver for a UK company name or number (gap BE-04).
//
// A number goes straight to the profile. A name goes to the register search, then ranking
// (rank.ts), then a decision. The resolver never guesses between plausible candidates: it
// resolves only when one candidate clearly wins, and otherwise returns a pick list with a
// suggested candidate marked. Calls stay low: profiles for at most 8 candidates, filing
// history for the top 3 only.

import { labelForAccountsTypeKey } from "./accountsType";
import { esefHint } from "./esefRoute";
import { hasAccountsFiling } from "./filings";
import { classifyInput } from "./numbers";
import {
  compareRankKeys,
  filesAccounts,
  isOverseasRegistration,
  isStrongMatch,
  matchName,
  matchStrength,
  rankKey,
  statusTier,
  type NameMatch,
} from "./rank";
import type { Candidate, ChProfile, ChSearchItem, ResolveClient, ResolveResult } from "./types";

export const MAX_CANDIDATES = 8;
export const PROFILE_LOOKUPS = 8;
export const FILING_LOOKUPS = 3;

export async function resolveCompany(input: string, client: ResolveClient): Promise<ResolveResult> {
  const cls = classifyInput(input);
  if (cls.kind === "excluded") return { kind: "excluded", number: cls.number, reason: cls.reason };
  if (cls.kind === "number") return resolveNumber(cls.number, cls.register, client);
  if (!cls.name) return { kind: "none", reason: "Nothing was typed." };
  return resolveName(cls.name, client);
}

// ---------------------------------------------------------------------------
// Number input
// ---------------------------------------------------------------------------

async function resolveNumber(number: string, register: string, client: ResolveClient): Promise<ResolveResult> {
  const profile = await client.profile(number);
  if (!profile) return { kind: "none", reason: `No company with number ${number} is on the register.` };
  if (isOverseasRegistration(profile.company_number, profile.type)) {
    return {
      kind: "excluded",
      number,
      reason: `${number} is an overseas registration (${profile.type}). It files no UK accounts of its own.`,
    };
  }
  const company = candidateFromProfile(profile);
  company.why = [`typed as a company number (${register})`, statusPhrase(company), accountsPhrase(company)];
  const esef = await esefHint(company, client);
  if (esef) company.esef = esef;
  return {
    kind: "resolved",
    company,
    reason: `Company number ${number} is ${company.name}, ${statusPhrase(company)}.`,
    ...(esef ? { esef } : {}),
  };
}

// ---------------------------------------------------------------------------
// Name input
// ---------------------------------------------------------------------------

interface Ranked {
  c: Candidate;
  searchIndex: number;
}

async function resolveName(name: string, client: ResolveClient): Promise<ResolveResult> {
  const search = await client.search(name);
  const items = search.items ?? [];
  if (items.length === 0) {
    return { kind: "none", reason: `The register search for "${name}" returned no companies.` };
  }

  const ranked: Ranked[] = [];
  const overseas: ChSearchItem[] = [];
  items.forEach((item, searchIndex) => {
    const m = matchName(name, item.title, snippetNames(item.snippet));
    if (!m) return;
    if (isOverseasRegistration(item.company_number, item.company_type)) {
      overseas.push(item);
      return;
    }
    ranked.push({ c: candidateFromSearch(item, m), searchIndex });
  });

  const overseasNote = overseas.length
    ? ` Left out as overseas registrations: ${overseas.map((o) => `${o.title} ${o.company_number}`).join(", ")}.`
    : "";

  if (ranked.length === 0) {
    if (overseas.length) {
      return {
        kind: "excluded",
        number: overseas[0].company_number,
        reason: `The only register matches for "${name}" are overseas registrations, which file no UK accounts of their own.${overseasNote}`,
      };
    }
    return {
      kind: "none",
      reason: `The register search for "${name}" returned ${items.length} companies, but none carries every word of the name, now or as a previous name.`,
    };
  }

  sortRanked(ranked);

  // Profiles: last accounts, full previous names, registered office locality.
  for (const r of ranked.slice(0, PROFILE_LOOKUPS)) {
    const profile = await client.profile(r.c.number);
    if (!profile) continue;
    enrichFromProfile(r, profile, name);
  }
  sortRanked(ranked);

  // Filing history for the top few only.
  for (const r of ranked.slice(0, FILING_LOOKUPS)) {
    r.c.hasAccountsFiling = hasAccountsFiling(await client.filingHistory(r.c.number));
  }
  sortRanked(ranked);

  const candidates = ranked.slice(0, MAX_CANDIDATES).map((r, i) => {
    r.c.why = explain(r, i);
    return r.c;
  });
  for (const c of candidates) {
    const esef = await esefHint(c, client);
    if (esef) c.esef = esef;
  }

  const winner = candidates[0];
  const rivals = ranked.slice(1).filter((r) => isStrongMatch(r.c.match) && statusTier(r.c.status) < 2);
  const clearWin =
    (winner.match === "exact" || winner.match === "compact") &&
    winner.status === "active" &&
    filesAccounts(winner.type) &&
    winner.hasAccountsFiling === true &&
    rivals.length === 0;
  const onlyOne = ranked.length === 1 && isStrongMatch(winner.match) && winner.match !== "previous-name";

  if (clearWin || onlyOne) {
    const basis = clearWin
      ? `the only active company named exactly "${name}" that files accounts, and no other company on the register shares or once had that name`
      : `the only register company whose name matches "${name}" (${statusPhrase(winner)})`;
    return {
      kind: "resolved",
      company: winner,
      reason: `${winner.name} ${winner.number} is ${basis}.${overseasNote}`,
      ...(winner.esef ? { esef: winner.esef } : {}),
    };
  }

  return {
    kind: "pick",
    candidates,
    suggested: winner.number,
    reason: pickReason(name, ranked, rivals.length) + overseasNote,
  };
}

function sortRanked(ranked: Ranked[]): void {
  ranked.sort((a, b) => compareRankKeys(rankKey(a.c, a.searchIndex), rankKey(b.c, b.searchIndex)));
}

// The search snippet lists previous names that matched, joined by a middle dot.
function snippetNames(snippet: string | undefined): string[] {
  if (!snippet) return [];
  return snippet
    .split("·")
    .map((s) => s.trim())
    .filter(Boolean);
}

function candidateFromSearch(item: ChSearchItem, m: NameMatch): Candidate {
  return {
    number: item.company_number,
    name: item.title,
    status: item.company_status ?? "",
    type: item.company_type ?? "",
    incorporatedOn: item.date_of_creation ?? null,
    locality: item.address?.locality ?? null,
    lastAccounts: null,
    previousNames: snippetNames(item.snippet),
    match: m.kind,
    ...(m.previousName ? { matchedPreviousName: m.previousName } : {}),
    hasAccountsFiling: null,
    why: [],
  };
}

function candidateFromProfile(p: ChProfile): Candidate {
  return {
    number: p.company_number,
    name: p.company_name,
    status: p.company_status ?? "",
    type: p.type ?? "",
    incorporatedOn: p.date_of_creation ?? null,
    locality: p.registered_office_address?.locality ?? null,
    lastAccounts: {
      madeUpTo: p.accounts?.last_accounts?.made_up_to ?? null,
      type: labelForAccountsTypeKey(p.accounts?.last_accounts?.type),
    },
    previousNames: (p.previous_company_names ?? []).map((n) => n.name),
    hasAccountsFiling: null,
    why: [],
  };
}

function enrichFromProfile(r: Ranked, p: ChProfile, query: string): void {
  const fromProfile = candidateFromProfile(p);
  r.c.lastAccounts = fromProfile.lastAccounts;
  if (fromProfile.previousNames.length) r.c.previousNames = fromProfile.previousNames;
  r.c.locality = r.c.locality ?? fromProfile.locality;
  r.c.incorporatedOn = r.c.incorporatedOn ?? fromProfile.incorporatedOn;
  // The profile holds every previous name; the search snippet only some. A stronger match
  // on the full list counts.
  const m = matchName(query, r.c.name, r.c.previousNames);
  if (m && matchStrength(m.kind) < matchStrength(r.c.match)) {
    r.c.match = m.kind;
    if (m.previousName) r.c.matchedPreviousName = m.previousName;
    else delete r.c.matchedPreviousName;
  }
}

// ---------------------------------------------------------------------------
// Plain reasons
// ---------------------------------------------------------------------------

function statusPhrase(c: Candidate): string {
  switch (statusTier(c.status)) {
    case 0:
      return "active";
    case 2:
      return c.status === "dissolved" ? "dissolved" : `closed (${c.status})`;
    default:
      return c.status === "liquidation" ? "in liquidation" : `status ${c.status}`;
  }
}

function accountsPhrase(c: Candidate): string {
  if (!c.lastAccounts) return "profile not read";
  const { type, madeUpTo } = c.lastAccounts;
  if (!madeUpTo) return "no accounts on the profile";
  const shell = type === "micro-entity" || type === "dormant" ? ", which suggests a shell or a small company" : "";
  return `last accounts ${type}, made up to ${madeUpTo}${shell}`;
}

function explain(r: Ranked, position: number): string[] {
  const c = r.c;
  const why: string[] = [`ranked ${position + 1}`];
  switch (c.match) {
    case "exact":
      why.push("exact name match");
      break;
    case "compact":
      why.push("same name ignoring spaces and punctuation");
      break;
    case "previous-name":
      why.push(`previously named ${c.matchedPreviousName ?? "the name typed"}`);
      break;
    case "contains":
      why.push(
        c.matchedPreviousName
          ? `every word of the name appears in a previous name, ${c.matchedPreviousName}`
          : "every word of the name appears in the company name, but it is not the same name"
      );
      break;
  }
  why.push(statusPhrase(c));
  if (!filesAccounts(c.type)) why.push(`company type ${c.type || "unknown"} does not file accounts at Companies House`);
  why.push(accountsPhrase(c));
  if (c.hasAccountsFiling === true) why.push("has an accounts filing with a document");
  else if (c.hasAccountsFiling === false) why.push("no accounts filing with a document");
  if (c.previousNames.length && c.match !== "previous-name") {
    why.push(`previous names: ${c.previousNames.slice(0, 3).join(", ")}`);
  }
  return why;
}

function pickReason(name: string, ranked: Ranked[], strongRivals: number): string {
  const strong = ranked.filter((r) => isStrongMatch(r.c.match));
  if (strong.length === 0) {
    return `No company is named exactly "${name}". ${ranked.length} contain every word of it. Confirm which one.${allGoneNote(ranked)}`;
  }
  const current = strong.filter((r) => r.c.match !== "previous-name").length;
  const previous = strong.length - current;
  const parts = [
    current ? `${current} on the current name` : "",
    previous ? `${previous} on a previous name` : "",
  ].filter(Boolean);
  const lead = `${strong.length} ${strong.length === 1 ? "company matches" : "companies match"} "${name}" closely (${parts.join(", ")})`;
  const top = ranked[0].c;
  let why: string;
  if (strongRivals > 0) why = "more than one of them is still on the register";
  else if (top.status !== "active") why = `the best match is ${statusPhrase(top)}`;
  else if (top.hasAccountsFiling !== true) why = "the best match has no accounts filing with a document";
  else if (!isStrongMatch(top.match) || top.match === "previous-name") why = "the best match is not on the current name";
  else why = "no single candidate clearly wins";
  return `${lead}, and ${why}. Confirm which one.${allGoneNote(ranked)}`;
}

// WP-BE14: New Look, Poundland and Homebase (QA04, 23 and 27 Sep) each matched only dissolved
// holding companies whose names the list typed exactly; the trading groups the list meant file
// under other names that carry none of the typed words, so no ranking can reach them without
// guessing. The pick list says so instead of letting a years-old or dormant sheet pass as the
// business.
function allGoneNote(ranked: Ranked[]): string {
  if (ranked.length === 0 || !ranked.every((r) => statusTier(r.c.status) === 2)) return "";
  const n = ranked.length;
  return ` ${n === 1 ? "The only company that matches is" : `All ${n} companies that match are`} dissolved, so the last accounts are old. If you meant a business that still trades, it files under another company name: type that name or its number.`;
}
