// eval/gold/uk-facilities.ts
// The comparison of a facilities-table row with a gold facility (WP-BE16), shared by
// test/capitalStructure.test.ts and the UK eval gate (eval/gold/uk-run.ts). Moved here by WP-BE13
// so the gate and the test use one definition of "contradicts".
//
// A cell "contradicts" the gold when it is agreed and says something the gold does not: a
// different amount, a nil the gold does not have, a date or rate the gold does not print, or a
// meaningful word on security, lender or ranking that is not in the gold's field or its verbatim
// quote. An abstention is not a contradiction; it is recorded as coverage.

import { maturitySignature, normWords, rateSignature } from "../../lib/vision/capitalStructure";
import type { FacilityRow } from "../../lib/engine/types";
import type { UkGoldFacility } from "./uk";

const MEANINGLESS = new Set(["a", "an", "and", "at", "by", "in", "is", "are", "of", "on", "over", "per", "which", "with", "its", "the", "bond", "bonds", "note", "notes", "loan", "loans", "facility", "facilities", "due", "maturing", "matures", "repayable", "annum"]);
const meaningful = (s: string) => normWords(s).split(" ").filter((w) => w && !MEANINGLESS.has(w));

export function compareToGold(g: UkGoldFacility, row: FacilityRow | null): { agreed: string[]; abstained: string[]; contradictions: string[] } {
  const agreed: string[] = [];
  const abstained: string[] = [];
  const contradictions: string[] = [];
  if (!row) return { agreed, abstained, contradictions };
  const quoteWords = new Set(normWords(`${g.quote ?? ""}`).split(" "));
  const inGold = (field: string | undefined, text: string) => {
    const allowed = new Set([...quoteWords, ...normWords(field ?? "").split(" ")]);
    return meaningful(text).filter((w) => !allowed.has(w));
  };
  for (const [k, c] of Object.entries(row.cells)) {
    if (c.status === "abstain") abstained.push(k);
    if (c.status !== "agreed") continue;
    agreed.push(k);
    if (k === "committed" && g.amount !== undefined && c.pounds !== g.amount) contradictions.push(`committed ${c.pounds} against gold ${g.amount}`);
    if (k === "drawn") {
      if (c.nil && g.drawnAtPeriodEnd !== 0) contradictions.push(`drawn nil against gold ${g.drawnAtPeriodEnd}`);
      if (!c.nil && g.drawnAtPeriodEnd !== undefined && c.pounds !== g.drawnAtPeriodEnd) contradictions.push(`drawn ${c.pounds} against gold ${g.drawnAtPeriodEnd}`);
    }
    if (k === "maturity") {
      const gs = new Set(maturitySignature(`${g.maturity ?? ""} ${g.quote ?? ""}`));
      const extra = maturitySignature(c.text ?? "").filter((x) => !gs.has(x));
      if (extra.length) contradictions.push(`maturity "${c.text}" prints ${extra.join(", ")}, which the gold does not`);
    }
    if (k === "rateOrMargin") {
      const gs = new Set(rateSignature(`${g.rate ?? ""} ${g.quote ?? ""}`));
      const extra = rateSignature(c.text ?? "").filter((x) => !gs.has(x));
      if (extra.length) contradictions.push(`rate "${c.text}" prints ${extra.join(", ")}, which the gold does not`);
    }
    if (k === "security" || k === "lender" || k === "ranking") {
      const field = k === "security" ? g.security : k === "lender" ? g.lender : g.ranking ?? g.security;
      const extra = inGold(field, c.text ?? "");
      if (extra.length) contradictions.push(`${k} "${c.text}" has ${extra.join(", ")}, which the gold does not`);
    }
  }
  return { agreed, abstained, contradictions };
}

// The row for a gold facility: the one whose agreed committed amount is the gold's, else the one of
// the same type. Matching on type alone never passes an amount unchecked, because the amount is
// compared in compareToGold.
export function rowForGold(rows: FacilityRow[], g: UkGoldFacility): FacilityRow | null {
  return (
    rows.find((r) => r.cells.committed.status === "agreed" && r.cells.committed.pounds === g.amount) ??
    rows.find((r) => r.type === g.type) ??
    null
  );
}
