// test/kb-masterid.test.ts
// Master-ID resolution helpers: precedence, matching, merging and survivor selection. All sync
// and deterministic, but exposed via an async register fn to match the other suites.

import { suite, test, assert, assertEqual } from "./harness";
import type { EntityIdentifiers } from "../lib/kb/kbTypes";
import {
  chooseMasterId,
  identifiersMatch,
  mergeIdentifiers,
  strongerId,
  normLei,
  normCh,
  normCik,
  normName,
} from "../lib/kb/masterId";

export async function registerKbMasterIdTests() {
  suite("kb-masterid");

  // -- normalisation ---------------------------------------------------------

  test("normalisers fold to a canonical form", () => {
    assertEqual(normLei("  529900t8bm49aurse337  "), "529900T8BM49AURSE337", "lei upper + trim");
    assertEqual(normCh("  sc123456 "), "SC123456", "ch upper + trim");
    assertEqual(normCik("CIK0000320193"), "320193", "cik digits only, leading zero padding dropped");
    assertEqual(normName("Meridian Foods PLC!"), "meridian-foods-plc", "name slug");
    assertEqual(normName("  --A & B--  "), "a-b", "name trims edge dashes");
  });

  // -- (a) chooseMasterId precedence ----------------------------------------

  test("chooseMasterId: lei beats ch beats cik beats name, each normalised", () => {
    const all: EntityIdentifiers = {
      lei: "529900t8bm49aurse337",
      chNumber: "sc123456",
      cik: "320193",
      name: "Meridian Foods PLC",
    };
    assertEqual(chooseMasterId(all), "lei:529900T8BM49AURSE337", "lei wins and is upper-cased");

    const noLei: EntityIdentifiers = { chNumber: " sc123456 ", cik: "320193", name: "Meridian" };
    assertEqual(chooseMasterId(noLei), "ch:SC123456", "ch wins when no lei, upper + trim");

    const cikOnly: EntityIdentifiers = { cik: "CIK0000320193", name: "Apple" };
    assertEqual(chooseMasterId(cikOnly), "cik:320193", "cik wins when no lei/ch, padding dropped");

    const nameOnly: EntityIdentifiers = { name: "Redacta Holdings Ltd" };
    assertEqual(chooseMasterId(nameOnly), "name:redacta-holdings-ltd", "name is last resort, slug");
  });

  test("chooseMasterId: empty identifier strings are ignored", () => {
    const ids: EntityIdentifiers = { lei: "  ", chNumber: "", cik: "abc", name: "Fallback Co" };
    // lei blank after trim, ch empty, cik has no digits -> falls through to name.
    assertEqual(chooseMasterId(ids), "name:fallback-co", "blank strong ids fall through to name");
  });

  // -- (b) identifiersMatch --------------------------------------------------

  test("identifiersMatch: true on a shared LEI (case-insensitive)", () => {
    const a: EntityIdentifiers = { lei: "529900T8BM49AURSE337", name: "Meridian" };
    const b: EntityIdentifiers = { lei: "529900t8bm49aurse337", name: "Different Name Ltd" };
    assert(identifiersMatch(a, b), "shared lei matches despite different names");
  });

  test("identifiersMatch: true on a shared CH number", () => {
    const a: EntityIdentifiers = { chNumber: "SC123456", name: "Meridian" };
    const b: EntityIdentifiers = { chNumber: " sc123456 ", name: "Meridian Foods" };
    assert(identifiersMatch(a, b), "shared ch matches");
  });

  test("identifiersMatch: true on a shared CIK", () => {
    const a: EntityIdentifiers = { cik: "320193", name: "Apple" };
    const b: EntityIdentifiers = { cik: "CIK-320193", name: "Apple Inc" };
    assert(identifiersMatch(a, b), "shared cik matches after digit normalisation");
  });

  test("identifiersMatch: FALSE when only the name agrees", () => {
    const a: EntityIdentifiers = { lei: "AAAA00000000000000A1", name: "Acme Corp" };
    const b: EntityIdentifiers = { cik: "999999", name: "Acme Corp" };
    assert(!identifiersMatch(a, b), "identical name alone is never a match");

    const nameOnlyA: EntityIdentifiers = { name: "Acme Corp" };
    const nameOnlyB: EntityIdentifiers = { name: "Acme Corp" };
    assert(!identifiersMatch(nameOnlyA, nameOnlyB), "two name-only entities do not match");
  });

  test("identifiersMatch: empty join keys never match", () => {
    const a: EntityIdentifiers = { lei: "", chNumber: "", cik: "", name: "X" };
    const b: EntityIdentifiers = { lei: "", chNumber: "", cik: "", name: "X" };
    assert(!identifiersMatch(a, b), "all-empty keys do not spuriously match");
  });

  test("identifiersMatch: a padded and a bare CIK are the same entity", () => {
    const a: EntityIdentifiers = { cik: "0000320193", name: "Apple Inc" };
    const b: EntityIdentifiers = { cik: "320193", name: "Apple" };
    assert(identifiersMatch(a, b), "EDGAR's zero-padded CIK matches the bare form");
  });

  test("identifiersMatch: a conflicting LEI blocks a merge on a weaker shared key", () => {
    // Two DIFFERENT legal entities that share a CH number in bad data but carry different LEIs
    // must NOT fuse: the LEI is authoritative when both are present.
    const a: EntityIdentifiers = { chNumber: "SC111111", lei: "AAAA00000000000000A1", name: "Alpha PLC" };
    const b: EntityIdentifiers = { chNumber: "SC111111", lei: "BBBB00000000000000B2", name: "Beta PLC" };
    assert(!identifiersMatch(a, b), "different LEIs never merge even on a shared CH number");
  });

  // -- (c) mergeIdentifiers --------------------------------------------------

  test("mergeIdentifiers: unions all three keys", () => {
    const a: EntityIdentifiers = { lei: "529900T8BM49AURSE337", name: "Meridian Foods PLC" };
    const b: EntityIdentifiers = { chNumber: "SC123456", cik: "320193", name: "Meridian" };
    const m = mergeIdentifiers(a, b);
    assertEqual(m.lei, "529900T8BM49AURSE337", "lei carried from a");
    assertEqual(m.chNumber, "SC123456", "ch carried from b");
    assertEqual(m.cik, "320193", "cik carried from b");
    assertEqual(m.name, "Meridian Foods PLC", "name prefers a");
  });

  test("mergeIdentifiers: prefers a's value when both present, falls back to b for name", () => {
    const a: EntityIdentifiers = { lei: "AAAA00000000000000A1", name: "" };
    const b: EntityIdentifiers = { lei: "BBBB00000000000000B2", name: "Fallback Name Ltd" };
    const m = mergeIdentifiers(a, b);
    assertEqual(m.lei, "AAAA00000000000000A1", "a's lei preferred when both present");
    assertEqual(m.name, "Fallback Name Ltd", "name falls back to b when a's is empty");
  });

  // -- (d) strongerId --------------------------------------------------------

  test("strongerId: picks lei over ch over cik over name", () => {
    assertEqual(strongerId("lei:X", "ch:Y"), "lei:X", "lei beats ch");
    assertEqual(strongerId("ch:Y", "lei:X"), "lei:X", "order does not matter, lei beats ch");
    assertEqual(strongerId("ch:Y", "cik:9"), "ch:Y", "ch beats cik");
    assertEqual(strongerId("cik:9", "name:z"), "cik:9", "cik beats name");
    assertEqual(strongerId("name:a", "name:b"), "name:a", "tie returns first argument");
  });
}
