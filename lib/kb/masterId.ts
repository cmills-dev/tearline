// lib/kb/masterId.ts
// Pure, deterministic master-ID resolution helpers for the knowledge-graph entity spine.
// These decide how the SAME real-world company, seen through different sources (Companies House
// number, SEC CIK, GLEIF LEI), collapses to ONE internal master entity. No I/O, no store, no
// network: every function here is a pure transform of its arguments and is fully testable.
//
// Join-key rule: only lei / chNumber / cik are join keys. A name is NEVER a join key (too
// ambiguous); it is only a last-resort master id and a display label.

import type { EntityIdentifiers } from "./kbTypes";

// -- normalisation helpers ---------------------------------------------------

// LEI: 20-char alphanumeric, compared upper-cased and trimmed.
export function normLei(lei: string | undefined): string {
  return (lei ?? "").trim().toUpperCase();
}

// Companies House number: upper-cased and trimmed (some are alphanumeric, e.g. "SC123456").
export function normCh(chNumber: string | undefined): string {
  return (chNumber ?? "").trim().toUpperCase();
}

// SEC CIK: digits only, with leading-zero PADDING dropped, so EDGAR's zero-padded canonical form
// ("0000320193") and the bare form ("320193") resolve to the same entity rather than splitting.
export function normCik(cik: string | undefined): string {
  return (cik ?? "").replace(/\D/g, "").replace(/^0+/, "");
}

// Name: lower-cased, every run of non-alphanumeric characters folded to a single "-", with any
// leading or trailing "-" trimmed. Deterministic and stable for use as a last-resort master id.
export function normName(name: string | undefined): string {
  return (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// -- master id selection -----------------------------------------------------

// The strongest available identifier wins, in strict precedence:
//   LEI  -> `lei:<upper-lei>`
//   CH   -> `ch:<upper-ch>`
//   CIK  -> `cik:<digits>`
//   name -> `name:<slug>`   (last resort only)
export function chooseMasterId(ids: EntityIdentifiers): string {
  const lei = normLei(ids.lei);
  if (lei) return `lei:${lei}`;

  const ch = normCh(ids.chNumber);
  if (ch) return `ch:${ch}`;

  const cik = normCik(ids.cik);
  if (cik) return `cik:${cik}`;

  return `name:${normName(ids.name)}`;
}

// -- matching ----------------------------------------------------------------

// True only if a and b are the same legal entity by a JOIN KEY. The LEI is authoritative: when
// BOTH carry an LEI, they match if and only if the LEIs agree, so two entities that merely share
// a weaker key (CH / CIK, possibly from bad data) but carry DIFFERENT LEIs never fuse. When at
// most one side has an LEI, a shared non-empty CH number or CIK is a match. A shared NAME is never
// a match, so entities agreeing only on their name return false.
export function identifiersMatch(a: EntityIdentifiers, b: EntityIdentifiers): boolean {
  const leiA = normLei(a.lei);
  const leiB = normLei(b.lei);
  if (leiA && leiB) return leiA === leiB; // both LEIs present: authoritative, agree or not

  const chA = normCh(a.chNumber);
  const chB = normCh(b.chNumber);
  if (chA && chA === chB) return true;

  const cikA = normCik(a.cik);
  const cikB = normCik(b.cik);
  if (cikA && cikA === cikB) return true;

  return false;
}

// -- merging -----------------------------------------------------------------

// The union of two identifier sets: keep each of lei / chNumber / cik from whichever side has it,
// preferring a's value when both are present and differ (they should not differ if
// identifiersMatch was true). name = a.name || b.name.
export function mergeIdentifiers(a: EntityIdentifiers, b: EntityIdentifiers): EntityIdentifiers {
  const merged: EntityIdentifiers = {
    name: a.name || b.name,
  };

  const lei = a.lei || b.lei;
  if (lei) merged.lei = lei;

  const chNumber = a.chNumber || b.chNumber;
  if (chNumber) merged.chNumber = chNumber;

  const cik = a.cik || b.cik;
  if (cik) merged.cik = cik;

  return merged;
}

// -- survivor selection ------------------------------------------------------

// Rank of a master-id prefix: lei > ch > cik > name. Unknown prefixes rank weakest.
const PREFIX_RANK: Record<string, number> = {
  lei: 4,
  ch: 3,
  cik: 2,
  name: 1,
};

function prefixRank(id: string): number {
  const prefix = id.slice(0, id.indexOf(":"));
  return PREFIX_RANK[prefix] ?? 0;
}

// Given two master ids, return the one with the stronger prefix (lei > ch > cik > name). Used to
// pick the survivor when a merge collapses two entities. On a tie, a is returned.
export function strongerId(a: string, b: string): string {
  return prefixRank(b) > prefixRank(a) ? b : a;
}
