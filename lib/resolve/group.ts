// lib/resolve/group.ts
// Group following (audit BE-05). An audit-exempt subsidiary files no figures worth reading,
// and a thin holding company's own accounts show an investment and little else. The figures a
// lender wants are in the parent's GROUP accounts. This walks up from the company the resolver
// picked to the nearest parent that files group accounts, and says how it got there.
//
// Two routes, in this order:
//
//   psc    the Companies House persons-with-significant-control register. A controlling
//          corporate PSC names its registration number, and a UK number is walked to.
//   gleif  the GLEIF level-2 relationship records: the subject's LEI, its direct (then
//          ultimate) accounting-consolidation parent, and that parent's Companies House number
//          when GLEIF says it is registered there (RA000585).
//
// Every step is checked, and a step that fails its check is not taken:
//   - a PSC link must be ACTIVE (no ceased_on) and CONTROLLING (more than half the shares or
//     votes, or the right to appoint the board). Significant influence alone is not ownership.
//   - two active controlling corporate PSCs is a joint venture. There is no single parent, and
//     the walk does not pick one.
//   - a registration number is only a claim typed by a filer ("6486367", "Ni70325"). The number
//     is normalised, the profile is read, and the register's name must match the PSC's name.
//   - the parent must be on the UK register. An overseas controller (Apollo, Delaware) files no
//     UK group accounts, so the walk stops there and says so.
//
// The walk stops at the NEAREST ancestor whose latest accounts are group accounts: that is the
// smallest consolidation the subject sits in, and the one whose figures are closest to it.
// Nothing here fetches a document or calls a model. It reads the register and GLEIF only.

import { getProfile, getPsc } from "../sources/companiesHouseLive";
import { nameScore, resolveLei } from "../sources/gleif";
import { fetchAccountsFilingHistory } from "./chClient";
import { selectLatestAccountsFiling, type SelectedAccountsFiling } from "./filings";
import { labelForAccountsTypeKey, type AccountsTypeLabel } from "./accountsType";
import type { ChFilingItem, ChProfile } from "./types";

// ---------------------------------------------------------------------------
// What the walk reads
// ---------------------------------------------------------------------------

export interface PscIdentification {
  legal_form?: string;
  legal_authority?: string;
  country_registered?: string;
  place_registered?: string;
  registration_number?: string;
}

// One row of GET /company/{number}/persons-with-significant-control, the fields read here.
export interface PscEntry {
  name?: string;
  kind?: string;
  natures_of_control?: string[];
  notified_on?: string;
  ceased_on?: string;
  ceased?: boolean;
  identification?: PscIdentification;
}

// A GLEIF record, trimmed to what the walk needs.
export interface GleifEntity {
  lei: string;
  legalName: string;
  registeredAs: string | null; // the local register number
  registeredAt: string | null; // the registration authority id, e.g. RA000585 for Companies House
  country: string | null;
}

export interface GroupClient {
  // null when the register has no company with this number.
  profile(number: string): Promise<ChProfile | null>;
  filingHistory(number: string): Promise<ChFilingItem[]>;
  // Every PSC row, active and ceased. An empty list when none is filed.
  psc(number: string): Promise<PscEntry[]>;
  // The LEI registered against this Companies House number, or null.
  leiForCompanyNumber(number: string): Promise<string | null>;
  // The GLEIF parent of this LEI, or null at the top of the tree or when none is reported.
  gleifParent(lei: string, kind: "direct-parent" | "ultimate-parent"): Promise<GleifEntity | null>;
}

// ---------------------------------------------------------------------------
// What the walk returns
// ---------------------------------------------------------------------------

export type GroupRoute = "psc" | "gleif";

export interface ChainNode {
  number: string;
  name: string;
  status: string;
  accountsType: AccountsTypeLabel; // of the latest AA/AAMD filing, else of the profile
  madeUpTo: string | null;
  // How this node was reached from the one before it. Absent on the subject.
  via?: { route: GroupRoute; evidence: string };
}

export interface ParentGroup {
  number: string;
  name: string;
  filing: SelectedAccountsFiling; // the parent's group accounts: what the figures will cite
  route: GroupRoute; // the route of the LAST step, the one that reached the parent
}

export type GroupFollowing =
  | {
      kind: "found";
      subject: ChainNode;
      parent: ParentGroup;
      chain: ChainNode[]; // subject first, parent last
      reason: string;
    }
  | {
      kind: "none";
      subject: ChainNode;
      chain: ChainNode[]; // as far as the walk got
      reason: string; // why no parent group accounts could be found, in one plain line
    };

// The labels whose own figures are not worth reading, so the sheet should show the group's.
const EXEMPT: ReadonlySet<AccountsTypeLabel> = new Set<AccountsTypeLabel>([
  "audit-exempt subsidiary",
  "filing-exempt subsidiary",
  "dormant",
]);

// A holding company's own accounts are an investment line and little else (audit BE-05, "thin
// holding company"). The register does not say a company holds subsidiaries, so the name is
// the signal: a company called a holding, bidco, topco or midco, whose own accounts are not
// group accounts. Deliberately narrow; a false negative only means the own figures are shown.
const HOLDING_NAME = /\b(holdings?|holdco|bidco|topco|midco|intermediate|parent)\b/i;

export type FollowDecision = { follow: true; why: string } | { follow: false; why: string };

// Should the sheet show the parent group's figures rather than the company's own?
export function shouldFollow(subject: Pick<ChainNode, "name" | "accountsType">, hasFiling: boolean): FollowDecision {
  if (subject.accountsType === "group") {
    return { follow: false, why: "it files group accounts of its own" };
  }
  if (!hasFiling) return { follow: true, why: "it has no accounts filing with figures to read" };
  if (EXEMPT.has(subject.accountsType)) {
    return { follow: true, why: `its own accounts are ${subject.accountsType} accounts` };
  }
  if (HOLDING_NAME.test(subject.name)) {
    return { follow: true, why: `it is a holding company whose own accounts are ${subject.accountsType}, not group` };
  }
  return { follow: false, why: `it files ${subject.accountsType} accounts of its own` };
}

// ---------------------------------------------------------------------------
// The PSC route
// ---------------------------------------------------------------------------

// A Companies House number from what a filer typed. Returns null when it cannot be one.
//   "6486367" -> "06486367"; "Ni70325" -> "NI070325"; "SC 123456" -> "SC123456".
export function normaliseChNumber(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const s = raw.toUpperCase().replace(/[\s.-]/g, "");
  const m = /^([A-Z]{2})?(\d{1,8})$/.exec(s);
  if (!m) return null;
  const prefix = m[1] ?? "";
  const width = 8 - prefix.length;
  if (m[2].length > width) return null;
  return prefix + m[2].padStart(width, "0");
}

// Words a filer uses for the UK register. Matched on place_registered and country_registered.
const UK_REGISTER =
  /\b(companies house|register(?:ar)? of companies|uk register|united kingdom|england|wales|scotland|northern ireland|uk)\b/i;

export function isUkRegistered(id: PscIdentification | undefined): boolean {
  if (!id) return false;
  return UK_REGISTER.test(`${id.place_registered ?? ""} ${id.country_registered ?? ""}`);
}

// Control, not influence: more than half the shares or the votes, or the board.
const CONTROLLING =
  /^(ownership-of-shares|voting-rights)-(50-to-75|75-to-100)-percent|^right-to-appoint-and-remove-directors/;

export function isControlling(p: PscEntry): boolean {
  return (p.natures_of_control ?? []).some((n) => CONTROLLING.test(n));
}

export function isActive(p: PscEntry): boolean {
  return !p.ceased_on && p.ceased !== true;
}

export function isCorporate(p: PscEntry): boolean {
  const k = p.kind ?? "";
  return k.startsWith("corporate-entity") || k.startsWith("legal-person");
}

// The single active controlling corporate PSC, or why there is none.
export function controllingCorporate(items: PscEntry[]): { psc: PscEntry } | { none: string } {
  const active = items.filter(isActive);
  const corporate = active.filter(isCorporate);
  const controlling = corporate.filter(isControlling);
  if (controlling.length === 1) return { psc: controlling[0] };
  if (controlling.length > 1) {
    return {
      none: `${controlling.length} corporate shareholders each control it (${controlling
        .map((p) => p.name)
        .join(", ")}), so there is no single parent`,
    };
  }
  if (corporate.length > 0) {
    return {
      none: `its corporate PSC (${corporate.map((p) => p.name).join(", ")}) is not recorded as holding more than half the shares or votes`,
    };
  }
  if (active.length > 0) return { none: "it is controlled by individuals, not by a parent company" };
  return { none: "no person with significant control is on the register" };
}

// The register's name must agree with the PSC's. nameScore strips legal forms, so "Ltd" and
// "Limited" compare equal; 0.85 lets through punctuation ("Pret Holding 2 Ltd") and nothing else.
const NAME_AGREES = 0.85;

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

// Six steps is deeper than any chain in the recorded set (Pret A Manger is three). It bounds a
// loop or a pathological register.
export const MAX_DEPTH = 6;

export interface FollowOptions {
  maxDepth?: number;
  // Which routes may be used, in order. Tests pass one to prove the other on its own.
  routes?: GroupRoute[];
}

interface Step {
  number: string;
  route: GroupRoute;
  evidence: string;
}

async function nodeFor(
  number: string,
  client: GroupClient,
  via?: ChainNode["via"],
): Promise<{ node: ChainNode; filing: SelectedAccountsFiling | null } | null> {
  const profile = await client.profile(number);
  if (!profile) return null;
  const filing = selectLatestAccountsFiling(await client.filingHistory(number));
  const accountsType = filing?.accountsType ?? labelForAccountsTypeKey(profile.accounts?.last_accounts?.type ?? null);
  return {
    node: {
      number: profile.company_number || number,
      name: profile.company_name,
      status: profile.company_status ?? "unknown",
      accountsType,
      madeUpTo: filing?.madeUpDate ?? profile.accounts?.last_accounts?.made_up_to ?? null,
      ...(via ? { via } : {}),
    },
    filing,
  };
}

// One step up by the PSC register. Returns the parent number, or why the step cannot be taken.
async function pscStep(node: ChainNode, client: GroupClient): Promise<Step | { none: string }> {
  const items = await client.psc(node.number);
  const found = controllingCorporate(items);
  if ("none" in found) return found;
  const p = found.psc;
  const id = p.identification;
  if (!id || (!id.place_registered && !id.country_registered && !id.registration_number)) {
    return { none: `its parent ${p.name} is filed with no registration details, so it cannot be found on the UK register` };
  }
  if (!isUkRegistered(id)) {
    const where = [id?.place_registered, id?.country_registered].filter(Boolean).join(", ") || "an unnamed register";
    return { none: `its parent ${p.name} is registered in ${where}, not on the UK register` };
  }
  const number = normaliseChNumber(id?.registration_number);
  if (!number) {
    return { none: `its parent ${p.name} is on the UK register but its number ("${id?.registration_number ?? ""}") is not a Companies House number` };
  }
  const profile = await client.profile(number);
  if (!profile) return { none: `its parent ${p.name} gives number ${number}, which is not on the register` };
  const score = nameScore(p.name ?? "", profile.company_name);
  if (score < NAME_AGREES) {
    return {
      none: `its parent is recorded as ${p.name} ${number}, but the register calls ${number} ${profile.company_name}, so the link is not trusted`,
    };
  }
  const control = (p.natures_of_control ?? []).filter((n) => CONTROLLING.test(n)).join(", ");
  return {
    number,
    route: "psc",
    evidence: `PSC register of ${node.number}: ${p.name} (${number}), ${control}${p.notified_on ? `, notified ${p.notified_on}` : ""}`,
  };
}

// One step up by GLEIF. Direct parent first, then ultimate parent.
async function gleifStep(node: ChainNode, client: GroupClient): Promise<Step | { none: string }> {
  const lei = await client.leiForCompanyNumber(node.number);
  if (!lei) return { none: "it has no LEI registered against its company number" };
  for (const kind of ["direct-parent", "ultimate-parent"] as const) {
    const parent = await client.gleifParent(lei, kind);
    if (!parent) continue;
    if (parent.registeredAt !== CH_REGISTRATION_AUTHORITY || !parent.registeredAs) {
      return { none: `its GLEIF ${kind} ${parent.legalName} (${parent.lei}) is not registered at Companies House` };
    }
    const number = normaliseChNumber(parent.registeredAs);
    if (!number) return { none: `its GLEIF ${kind} ${parent.legalName} gives no usable company number` };
    return {
      number,
      route: "gleif",
      evidence: `GLEIF ${kind} of ${lei}: ${parent.legalName} (${parent.lei}), Companies House ${number}`,
    };
  }
  return { none: `GLEIF reports no parent for its LEI ${lei}` };
}

export const CH_REGISTRATION_AUTHORITY = "RA000585";

// Walk from `number` to the nearest parent that files group accounts.
export async function followToGroup(
  number: string,
  client: GroupClient,
  opts: FollowOptions = {},
): Promise<GroupFollowing> {
  const routes = opts.routes ?? ["psc", "gleif"];
  const maxDepth = opts.maxDepth ?? MAX_DEPTH;
  const start = await nodeFor(number, client);
  if (!start) {
    const subject: ChainNode = { number, name: number, status: "unknown", accountsType: "unknown", madeUpTo: null };
    return { kind: "none", subject, chain: [subject], reason: `${number} is not on the register` };
  }
  const subject = start.node;
  const chain: ChainNode[] = [subject];
  const seen = new Set([subject.number]);
  let current = subject;

  for (let depth = 0; depth < maxDepth; depth++) {
    const refusals: string[] = [];
    let step: Step | null = null;
    for (const route of routes) {
      const got = route === "psc" ? await pscStep(current, client) : await gleifStep(current, client);
      if ("none" in got) refusals.push(got.none);
      else {
        step = got;
        break;
      }
    }
    const who = current === subject ? subject.name : `${subject.name}'s parent ${current.name}`;
    if (!step) {
      return {
        kind: "none",
        subject,
        chain,
        reason: `No parent group accounts found for ${subject.name} ${subject.number}: for ${who}, ${refusals.join("; and ")}.`,
      };
    }
    if (seen.has(step.number)) {
      return { kind: "none", subject, chain, reason: `The ownership chain of ${subject.name} loops back to ${step.number}, so no parent was taken.` };
    }
    seen.add(step.number);
    const next = await nodeFor(step.number, client, { route: step.route, evidence: step.evidence });
    if (!next) {
      return { kind: "none", subject, chain, reason: `${who} points to ${step.number}, which is not on the register.` };
    }
    chain.push(next.node);
    if (next.filing && next.filing.accountsType === "group" && next.node.status !== "dissolved") {
      const steps = chain.length - 1;
      return {
        kind: "found",
        subject,
        chain,
        parent: { number: next.node.number, name: next.node.name, filing: next.filing, route: step.route },
        reason:
          `${next.node.name} ${next.node.number} files group accounts${next.filing.madeUpDate ? ` made up to ${next.filing.madeUpDate}` : ""}, ` +
          `${steps === 1 ? "the direct parent" : `${steps} steps up`} of ${subject.name} ${subject.number} by ${[...new Set(chain.slice(1).map((c) => c.via!.route.toUpperCase()))].join(" and ")}.`,
      };
    }
    current = next.node;
  }
  return {
    kind: "none",
    subject,
    chain,
    reason: `No parent group accounts found within ${maxDepth} steps above ${subject.name} ${subject.number}.`,
  };
}

// ---------------------------------------------------------------------------
// The live client
// ---------------------------------------------------------------------------

const GLEIF_BASE = "https://api.gleif.org/api/v1";

interface GleifRecordBody {
  data?: {
    id?: string;
    attributes?: {
      entity?: {
        legalName?: { name?: string };
        registeredAs?: string;
        registeredAt?: { id?: string };
        legalAddress?: { country?: string };
      };
    };
  };
}

export function gleifEntityFrom(body: GleifRecordBody | null | undefined): GleifEntity | null {
  const d = body?.data;
  if (!d?.id) return null;
  const e = d.attributes?.entity;
  return {
    lei: d.id,
    legalName: e?.legalName?.name ?? "",
    registeredAs: e?.registeredAs ?? null,
    registeredAt: e?.registeredAt?.id ?? null,
    country: e?.legalAddress?.country ?? null,
  };
}

export function createGroupClient(
  opts: { gleifFetch?: typeof fetch; leiForCompanyNumber?: (n: string) => Promise<string | null> } = {},
): GroupClient {
  const doFetch = opts.gleifFetch ?? fetch;
  return {
    async profile(number) {
      try {
        return (await getProfile(number)) as unknown as ChProfile;
      } catch (err) {
        if (err instanceof Error && /not found/i.test(err.message)) return null;
        throw err;
      }
    },
    filingHistory: fetchAccountsFilingHistory,
    async psc(number) {
      // getPsc returns the register's rows untouched, identification included.
      const data = (await getPsc(number)) as { items?: PscEntry[] };
      return data.items ?? [];
    },
    async leiForCompanyNumber(number) {
      if (opts.leiForCompanyNumber) return opts.leiForCompanyNumber(number);
      const rec = await resolveLei(number, { chNumber: number, fetchImpl: doFetch }).catch(() => null);
      return rec?.lei ?? null;
    },
    async gleifParent(lei, kind) {
      try {
        const res = await doFetch(`${GLEIF_BASE}/lei-records/${encodeURIComponent(lei)}/${kind}`, {
          headers: { Accept: "application/vnd.api+json" },
        } as RequestInit);
        if (!res.ok) return null; // 404 is the top of the tree, or a reporting exception
        return gleifEntityFrom((await res.json()) as GleifRecordBody);
      } catch {
        return null; // a GLEIF failure only loses this route
      }
    },
  };
}
