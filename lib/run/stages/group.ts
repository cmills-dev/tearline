// lib/run/stages/group.ts
// The group stage of a run (audit BE-05). It sits between the resolver and the builder: the
// resolver has picked a company, and before a document is fetched this asks whether that
// company's own accounts are worth reading. An audit-exempt subsidiary's are not, nor are a
// thin holding company's. For those, the sheet is built from the nearest parent's GROUP
// accounts, found by lib/resolve/group.ts, and every figure on it is labelled and cited as the
// parent's.
//
// It is shaped as a wrapper around the builder, `(number, options) => Promise<FactManifest>`,
// so it drops into RunDeps.build without the runner changing shape:
//
//   executeRun(run, { ...deps, build: withGroupFollowing(buildLiveFactManifest) })
//
// Its progress is reported on the `resolve` row, which the builder re-opens anyway to say
// which filing it picked. ManifestStage is a fixed list owned elsewhere, so the group step
// does not get a row of its own; its detail line names it.
//
// Honesty rules:
//   - a group sheet says so in the entity name, on every figure's document name, in a source
//     document of its own, and in the `group` block, which names the parent filing.
//   - a subsidiary whose parent cannot be found keeps its own figures and says so, with the
//     walk's reason. It is never quietly shown as though it were a standalone company.
//   - a group lookup that fails (a register outage, a budget error) never fails the run. The
//     own figures are built and the note says the lookup could not be made.

import { explainRunError } from "../plainError";
import type { BuildLiveOptions } from "../../sources/companiesHouseLive";
import type { FactManifest } from "../../engine/types";
import type { StageEvent } from "../../vision/types";
import {
  createGroupClient,
  followToGroup,
  shouldFollow,
  type ChainNode,
  type FollowOptions,
  type GroupClient,
  type GroupFollowing,
  type GroupRoute,
} from "../../resolve/group";
import { selectLatestAccountsFiling } from "../../resolve/filings";
import { labelForAccountsTypeKey } from "../../resolve/accountsType";
import { labelFigures, type SheetOf } from "../../engine/figureBasis";

export type Builder = (number: string, options: BuildLiveOptions) => Promise<FactManifest>;

// What the sheet is of, written onto the manifest. The manifest is stored as JSON, so this
// travels with it into the workspace and back out to any page that reads it.
export type GroupBasis =
  | {
      // The figures are the parent group's.
      basis: "parent-group";
      label: string; // one line for the top of the sheet
      subject: { number: string; name: string; accountsType: string };
      parent: {
        number: string;
        name: string;
        route: GroupRoute;
        filing: {
          transactionId: string;
          type: "AA" | "AAMD";
          madeUpDate: string | null;
          filedOn: string;
          accountsType: string;
          documentMetadataUrl: string;
        };
        publicUrl: string;
      };
      chain: ChainNode[];
      reason: string;
      // Figures the per-figure label made abstain (WP-BE19), each with its reason.
      unlabelled?: { id: string; reason: string }[];
    }
  | {
      // The figures are the company's own. `label` and `reason` say whether a parent group exists.
      basis: "own";
      label: string;
      subject: { number: string; name: string; accountsType: string };
      parentGroup: { number: string; name: string; madeUpDate: string | null } | null;
      chain: ChainNode[];
      reason: string;
      unlabelled?: { id: string; reason: string }[];
    };

export type GroupManifest = FactManifest & { group?: GroupBasis };

export const GROUP_SOURCE = "group-following";

const PUBLIC_BASE = "https://find-and-update.company-information.service.gov.uk/company";

export interface GroupStageOptions {
  client?: GroupClient;
  follow?: FollowOptions;
  now?: () => number;
}

function reporter(options: BuildLiveOptions, now: () => number) {
  return (status: StageEvent["status"], detail: string): void => {
    try {
      options.onStage?.({ stage: "resolve", status, detail, at: new Date(now()).toISOString() });
    } catch {
      /* a progress display cannot fail a run */
    }
  };
}

function subjectOf(f: GroupFollowing) {
  return { number: f.subject.number, name: f.subject.name, accountsType: f.subject.accountsType };
}

// Decide, walk if needed, then build. Never throws on the group step's account.
export function withGroupFollowing(build: Builder, stageOptions: GroupStageOptions = {}): Builder {
  return async (number, options) => {
    const now = stageOptions.now ?? Date.now;
    const say = reporter(options, now);
    const client = stageOptions.client ?? createGroupClient();

    say("start", `Checking whether ${number} reports its own figures or sits under a parent group`);

    let decision: { follow: boolean; why: string };
    let walk: GroupFollowing | null = null;
    let lookupFailed: string | null = null;
    let filing: ReturnType<typeof selectLatestAccountsFiling> = null;
    try {
      const profile = await client.profile(number);
      filing = selectLatestAccountsFiling(await client.filingHistory(number));
      const accountsType =
        filing?.accountsType ?? labelForAccountsTypeKey(profile?.accounts?.last_accounts?.type ?? null);
      const name = profile?.company_name ?? number;
      decision = shouldFollow({ name, accountsType }, filing !== null);
      // A company with group accounts of its own is the top of what matters: no walk.
      if (accountsType !== "group") walk = await followToGroup(number, client, stageOptions.follow);
    } catch (e) {
      decision = { follow: false, why: "the group lookup could not be made" };
      lookupFailed = explainRunError(e);
    }

    // --- Follow: the parent group's figures ------------------------------------------------
    if (decision.follow && walk?.kind === "found") {
      const found = walk;
      say("done", `Following ${found.subject.name} to its parent group: ${found.reason}`);
      const built = await build(found.parent.number, options);
      return labelAsGroup(built, found, decision.why, now);
    }

    // --- Own figures, with the reason ------------------------------------------------------
    let reason: string;
    let parentGroup: { number: string; name: string; madeUpDate: string | null } | null = null;
    if (lookupFailed) {
      reason = `The parent group could not be looked up (${lookupFailed}), so these are the company's own figures.`;
    } else if (!walk) {
      reason = `No parent group was looked for: ${decision.why}.`;
    } else if (walk.kind === "none") {
      reason = decision.follow
        ? `${walk.reason} These are the company's own figures, although ${decision.why}.`
        : `${walk.reason} These are the company's own figures.`;
    } else {
      parentGroup = {
        number: walk.parent.number,
        name: walk.parent.name,
        madeUpDate: walk.parent.filing.madeUpDate,
      };
      reason = `These are the company's own figures because ${decision.why}. Its parent group ${walk.parent.name} ${walk.parent.number} also files group accounts: ${walk.reason}`;
    }
    say("done", reason);
    const built = (await build(number, options)) as GroupManifest;
    const subject = walk ? subjectOf(walk) : { number, name: built.entity.companyName, accountsType: built.entity.accountsType };
    built.group = {
      basis: "own",
      label: parentGroup
        ? `Own figures of ${subject.name}; parent group ${parentGroup.name} ${parentGroup.number} files group accounts`
        : lookupFailed
          ? `Own figures of ${subject.name}; the parent group could not be looked up`
          : walk?.kind === "none"
            ? `Own figures of ${subject.name}; no parent group accounts could be found`
            : `Own figures of ${subject.name}`,
      subject,
      parentGroup,
      chain: walk?.chain ?? [],
      reason,
    };
    // Every own figure says whose it is and, where the register's accounts type says so, that it
    // is unaudited. A parent-group figure that somehow reached this sheet abstains.
    const entity = { number: built.entity.companyNumber || number, name: built.entity.companyName };
    const sameFiling = filing && filing.accountsType === built.entity.accountsType;
    const sheet: SheetOf = {
      kind: "own",
      entity,
      accountsType: built.entity.accountsType,
      filing: sameFiling
        ? { madeUpDate: filing!.madeUpDate, transactionId: filing!.transactionId }
        : { madeUpDate: built.entity.latestPeriodEnd || null, transactionId: null },
      parentNote: parentGroup
        ? `Its parent group ${parentGroup.name} ${parentGroup.number} files group accounts, which this sheet does not show.`
        : lookupFailed
          ? "Its parent group could not be looked up."
          : walk?.kind === "none"
            ? "No parent group accounts could be found to show instead."
            : null,
    };
    const outcome = labelFigures(built, sheet);
    if (outcome.abstained.length) built.group.unlabelled = outcome.abstained;
    return built;
  };
}

// Relabel a manifest built from the parent's filing so nobody can mistake it for the
// subsidiary's own figures.
export function labelAsGroup(
  built: FactManifest,
  found: Extract<GroupFollowing, { kind: "found" }>,
  why: string,
  now: () => number = Date.now,
): GroupManifest {
  const m = built as GroupManifest;
  const parent = found.parent;
  const made = parent.filing.madeUpDate ? ` made up to ${parent.filing.madeUpDate}` : "";
  const label =
    `Group figures of ${parent.name} ${parent.number}, the parent group of ${found.subject.name} ${found.subject.number}, ` +
    `from its group accounts${made}`;

  // The builder cites whatever filing it read. If it did not read the parent's group accounts
  // (a newer filing landed between the walk and the build), the sheet must not claim it did.
  const builtFrom = m.entity.companyNumber;
  if (builtFrom && builtFrom !== parent.number) {
    throw new Error(`the builder read ${builtFrom}, not the parent ${parent.number}`);
  }

  m.entity = {
    ...m.entity,
    companyName: `${parent.name} (group figures for ${found.subject.name})`,
  };
  // "parent group", not "group accounts": the register facts (status, incorporation) are the
  // parent's too, and they do not come from its accounts.
  const prefix = `${parent.name} ${parent.number} (parent group): `;
  for (const fact of Object.values(m.facts)) {
    if (fact.provenance && !fact.provenance.documentName.startsWith(prefix)) {
      fact.provenance = { ...fact.provenance, documentName: prefix + fact.provenance.documentName };
    }
  }
  for (const src of Object.values(m.sources)) {
    if (!src.documentName.startsWith(prefix)) src.documentName = prefix + src.documentName;
  }
  const route = [...new Set(found.chain.slice(1).map((c) => c.via?.route).filter(Boolean))].join(" and ");
  m.sources[GROUP_SOURCE] = {
    sourceId: GROUP_SOURCE,
    tag: "Reg",
    documentName: `Ownership chain from ${found.subject.name} ${found.subject.number} to ${parent.name} ${parent.number}`,
    retrievedAt: new Date(now()).toISOString(),
    origin: `Companies House ${route === "gleif" ? "and GLEIF " : ""}(${route.toUpperCase()} route): ${found.chain
      .map((c) => `${c.name} ${c.number}`)
      .join(" -> ")}`,
  };
  m.group = {
    basis: "parent-group",
    label,
    subject: subjectOf(found),
    parent: {
      number: parent.number,
      name: parent.name,
      route: parent.route,
      filing: {
        transactionId: parent.filing.transactionId,
        type: parent.filing.type,
        madeUpDate: parent.filing.madeUpDate,
        filedOn: parent.filing.filedOn,
        accountsType: parent.filing.accountsType,
        documentMetadataUrl: parent.filing.documentMetadataUrl,
      },
      publicUrl: `${PUBLIC_BASE}/${parent.number}/filing-history`,
    },
    chain: found.chain,
    reason: `${found.subject.name} is followed because ${why}. ${found.reason}`,
  };
  // The sheet's label is not enough: a figure copied off the sheet loses it. Every figure now
  // carries its own, and one that cannot, or that is not the parent group's, abstains.
  const outcome = labelFigures(m, {
    kind: "parent-group",
    entity: { number: parent.number, name: parent.name },
    subject: { number: found.subject.number, name: found.subject.name },
    filing: {
      type: parent.filing.type,
      accountsType: parent.filing.accountsType,
      madeUpDate: parent.filing.madeUpDate,
      filedOn: parent.filing.filedOn,
      transactionId: parent.filing.transactionId,
    },
  });
  if (outcome.abstained.length) m.group.unlabelled = outcome.abstained;
  return m;
}
