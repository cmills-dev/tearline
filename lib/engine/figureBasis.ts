// lib/engine/figureBasis.ts
// Whose figure is this (WP-BE19, adversarial review 21 Sep, finding 3). WP-BE12 builds an
// audit-exempt subsidiary's sheet from its parent's group accounts and labels the sheet. That is
// not enough: a figure copied off the sheet, into a cell, a card or an export, loses the sheet's
// heading. So every figure a run holds carries its own label, on its provenance, naming the
// filing it came from and whose it is. A figure that cannot be labelled abstains.
//
// The rules:
//   1. One sheet, one entity. A parent-group sheet holds only the parent group's figures, and an
//      own-figures sheet holds only the company's own. A figure already labelled as another
//      company's abstains. Nothing tops up a gap in one filing from the other.
//   2. A figure the run holds with no provenance cannot be labelled, so it abstains.
//   3. A derived figure is labelled only when every input is held and carries the same basis.
//      If an input abstained or is another company's, the derived figure abstains too.
//   4. An abstained figure carries no label. It has no provenance, so it cannot say it survived.
//   5. Nothing is ever called "audited". The engine does not read the auditor's report. Where
//      the register's accounts type says the accounts are unaudited (an audit exemption), the
//      label says so; otherwise the label is silent on audit.
//
// This module only removes values or adds words. It never creates a number.

import type { AccountsTypeLabel } from "../resolve/accountsType";
import type { Fact, FactManifest, FigureBasis, Provenance } from "./types";

export const MIXED_BASIS_ABSTAIN = "another company's figure on this sheet";
export const UNLABELLED_ABSTAIN = "no provenance to label";
export const DERIVED_BASIS_ABSTAIN = "an input to this figure is not held on this sheet's basis";

export interface Party {
  number: string;
  name: string;
}

// What a sheet is of, as the group stage decided it.
export type SheetOf =
  | {
      kind: "parent-group";
      entity: Party; // the parent that files group accounts
      subject: Party; // the subsidiary that was asked for
      filing: {
        type: string; // AA or AAMD
        accountsType: string;
        madeUpDate: string | null;
        filedOn: string;
        transactionId: string;
      };
    }
  | {
      kind: "own";
      entity: Party;
      accountsType: AccountsTypeLabel;
      filing: { madeUpDate: string | null; transactionId: string | null } | null;
      // One sentence on the parent group, when the stage has one: "No parent group accounts
      // could be found." Printed only on an audit-exempt company's figures, where it matters.
      parentNote: string | null;
    };

// The audit exemption the register's accounts type establishes, or null when it establishes
// none. Only types whose name says the accounts are unaudited are listed. "small" and
// "micro-entity" are not: such accounts may or may not be audited, and the type does not say.
export function auditExemption(accountsType: string): string | null {
  switch (accountsType) {
    case "audit-exempt subsidiary":
      return "the subsidiary audit exemption (Companies Act 2006, section 479A)";
    case "total exemption full":
    case "total exemption small":
      return "the small-company audit exemption (Companies Act 2006, section 477)";
    case "dormant":
      return "the dormant-company audit exemption (Companies Act 2006, section 480)";
    case "unaudited abridged":
      return "an audit exemption: the register files these as unaudited abridged accounts";
    case "filing-exempt subsidiary":
      return "the subsidiary filing exemption: the register shows no accounts filed of its own";
    default:
      return null;
  }
}

function isRegister(p: Provenance): boolean {
  return p.tag === "Reg" || p.tag === "NF";
}

function isDerived(f: Fact): boolean {
  return f.rung === "R2" || f.provenance?.sourceId === "derived";
}

function held(f: Fact): boolean {
  return f.value !== null && f.rung !== "R4";
}

// The label for one figure on a sheet. `from` is where on the record the figure sits.
export function basisFor(sheet: SheetOf, from: FigureBasis["from"]): FigureBasis {
  const e = sheet.entity;
  if (sheet.kind === "parent-group") {
    const f = sheet.filing;
    const made = f.madeUpDate ? ` made up to ${f.madeUpDate}` : "";
    const filing = `${f.type} ${f.accountsType} accounts${made}, filed ${f.filedOn}, transaction ${f.transactionId}`;
    const s = sheet.subject;
    const whose = `the parent group of ${s.name} ${s.number}`;
    const text =
      from === "register"
        ? `Parent group register entry: from the Companies House register of ${e.name} ${e.number}, ${whose}. It is not from the accounts, and it is not ${s.name}'s own.`
        : from === "derived"
          ? `Parent group figure, computed from parent group figures: the group accounts of ${e.name} ${e.number} (${filing}), ${whose}. It is the group's, not ${s.name}'s own.`
          : `Parent group figure: from the group accounts of ${e.name} ${e.number} (${filing}), ${whose}. It is the group's, not ${s.name}'s own.`;
    return { kind: "parent-group", entity: e, subject: s, from, filing, audit: "not-checked", text };
  }

  const made = sheet.filing?.madeUpDate ? ` made up to ${sheet.filing.madeUpDate}` : "";
  const tx = sheet.filing?.transactionId ? `, transaction ${sheet.filing.transactionId}` : "";
  const filing = `${sheet.accountsType} accounts${made}${tx}`;
  const exemption = auditExemption(sheet.accountsType);
  const base = { kind: "own" as const, entity: e, subject: e, from, filing };
  if (from === "register") {
    return { ...base, audit: "not-checked", text: `Register entry of ${e.name} ${e.number}, from the Companies House register.` };
  }
  const lead =
    from === "derived"
      ? `Own figure of ${e.name} ${e.number}, computed from its own figures in its ${filing}.`
      : `Own figure of ${e.name} ${e.number}, from its ${filing}.`;
  if (!exemption) return { ...base, audit: "not-checked", text: lead };
  const parent = sheet.parentNote ? ` ${sheet.parentNote}` : "";
  return {
    ...base,
    audit: "exempt",
    exemption,
    text: `${lead} Unaudited: the company claimed ${exemption}.${parent}`,
  };
}

function abstain(f: Fact, reason: string): void {
  const was = f.provenance
    ? ` It was ${f.value} ${f.unit}, cited to ${f.provenance.documentName} (${f.provenance.locator}).`
    : "";
  f.attemptLog = [
    ...(f.attemptLog ?? []),
    { step: "Basis label (whose figure this is)", outcome: "insufficient", detail: `Abstained: ${reason}.${was}` },
  ];
  f.value = null;
  f.rung = "R4";
  f.provenance = null;
  delete f.derivation;
  delete f.proxy;
  f.verification = { status: "NOT_APPLICABLE", checks: [] };
}

export interface LabelOutcome {
  labelled: string[]; // fact ids that now carry the sheet's basis
  abstained: { id: string; reason: string }[]; // fact ids this pass made abstain
}

// Label every figure on the manifest, in place. Safe to run twice.
export function labelFigures(m: FactManifest, sheet: SheetOf): LabelOutcome {
  const out: LabelOutcome = { labelled: [], abstained: [] };
  const drop = (f: Fact, reason: string) => {
    abstain(f, reason);
    out.abstained.push({ id: f.id, reason });
  };
  const foreign = (b: FigureBasis) =>
    b.entity.number !== sheet.entity.number || b.kind !== sheet.kind
      ? `${MIXED_BASIS_ABSTAIN}: this sheet shows ${sheet.kind === "parent-group" ? "the parent group figures" : "the own figures"} of ${sheet.entity.name} ${sheet.entity.number}, and this is ${b.kind === "parent-group" ? "a parent group figure" : "an own figure"} of ${b.entity.name} ${b.entity.number}. The two are never mixed`
      : null;

  const facts = Object.values(m.facts);
  const derived: Fact[] = [];

  // Base figures and register facts first.
  for (const f of facts) {
    if (!held(f)) {
      // An abstention may still hold a register provenance (a data-gap note). It never holds a label.
      if (f.provenance?.basis) f.provenance = { ...f.provenance, basis: undefined };
      continue;
    }
    if (!f.provenance) {
      drop(f, `${UNLABELLED_ABSTAIN}: the run holds a value for this line but no source for it, so it cannot say whose it is`);
      continue;
    }
    const clash = f.provenance.basis ? foreign(f.provenance.basis) : null;
    if (clash) {
      drop(f, clash);
      continue;
    }
    if (isDerived(f)) {
      derived.push(f);
      continue;
    }
    f.provenance = { ...f.provenance, basis: basisFor(sheet, isRegister(f.provenance) ? "register" : "accounts") };
    out.labelled.push(f.id);
  }

  // Derived figures, inputs first. A cycle, which the ladder never builds, abstains.
  const decided = new Map<string, boolean>();
  const visiting = new Set<string>();
  const settle = (f: Fact): boolean => {
    if (decided.has(f.id)) return decided.get(f.id)!;
    if (visiting.has(f.id)) return false;
    visiting.add(f.id);
    const inputs = f.derivation?.inputs ?? [];
    let ok = inputs.length > 0;
    for (const id of inputs) {
      const input = m.facts[id];
      if (!input || !held(input)) {
        ok = false;
        break;
      }
      if (derived.includes(input)) {
        if (!settle(input)) {
          ok = false;
          break;
        }
      } else if (input.provenance?.basis?.kind !== sheet.kind || input.provenance.basis.entity.number !== sheet.entity.number) {
        ok = false;
        break;
      }
    }
    visiting.delete(f.id);
    if (ok) {
      f.provenance = { ...f.provenance!, basis: basisFor(sheet, "derived") };
      out.labelled.push(f.id);
    } else {
      const missing = inputs.filter((id) => !m.facts[id] || !held(m.facts[id]));
      drop(
        f,
        inputs.length === 0
          ? `${DERIVED_BASIS_ABSTAIN}: it declares no inputs, so it cannot say whose figures it was computed from`
          : `${DERIVED_BASIS_ABSTAIN}${missing.length ? ` (${missing.join(", ")} abstained)` : ""}`
      );
    }
    decided.set(f.id, ok);
    return ok;
  };
  for (const f of derived) settle(f);

  labelCapitalStructure(m, sheet, out);
  return out;
}

export const CAPITAL_STRUCTURE_ID = "capitalStructure";

// The facilities table is labelled like a figure (WP-QA05). It carries the transaction it was read
// from, so it is also checked against the filing the sheet names: on a parent-group sheet a table
// read from any other filing (the subsidiary's own, or a newer one that landed between the walk
// and the build) is not the parent group's, and the whole table abstains.
function labelCapitalStructure(m: FactManifest, sheet: SheetOf, out: LabelOutcome): void {
  const cs = m.capitalStructure;
  if (!cs || cs.status !== "found") {
    if (cs) delete cs.basis;
    return;
  }
  const want = sheet.filing?.transactionId ?? null;
  const clash = cs.basis && (cs.basis.kind !== sheet.kind || cs.basis.entity.number !== sheet.entity.number);
  if (clash || (want && cs.transactionId !== want)) {
    const whose = sheet.kind === "parent-group" ? `the parent group accounts of ${sheet.entity.name} ${sheet.entity.number}` : `the own accounts of ${sheet.entity.name} ${sheet.entity.number}`;
    const reason = clash
      ? `${MIXED_BASIS_ABSTAIN}: the facilities table is labelled as another company's, and this sheet shows ${whose}`
      : `${MIXED_BASIS_ABSTAIN}: the facilities table was read from filing ${cs.transactionId}, and this sheet shows ${whose}, transaction ${want}`;
    cs.status = "abstain";
    cs.reason = `${reason}.`;
    cs.notes = [...cs.notes, `${cs.rows.length} facilit${cs.rows.length === 1 ? "y was" : "ies were"} not shown: ${reason}.`];
    cs.rows = [];
    delete cs.basis;
    out.abstained.push({ id: CAPITAL_STRUCTURE_ID, reason });
    return;
  }
  cs.basis = basisFor(sheet, "accounts");
  out.labelled.push(CAPITAL_STRUCTURE_ID);
}
