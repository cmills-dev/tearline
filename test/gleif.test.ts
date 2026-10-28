// test/gleif.test.ts
// LEI resolution: pure name normalisation/scoring, plus the deterministic CH-number path
// and the strict name-path abstain rules, exercised with a mock fetch (no network).

import { suite, test, assert, assertEqual } from "./harness";
import { normaliseName, nameScore, resolveLei } from "../lib/sources/gleif";

function jsonRes(status: number, body: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
}
function item(lei: string, name: string, opts: { ra?: string; country?: string; status?: string } = {}) {
  return {
    id: lei,
    attributes: {
      entity: {
        legalName: { name },
        legalAddress: { country: opts.country ?? "GB" },
        registeredAt: { id: opts.ra ?? "RA000585" },
      },
      registration: { status: opts.status ?? "ISSUED" },
    },
  };
}

suite("gleif / name normalisation + scoring");

test("normalisation strips legal forms, punctuation, leading THE", () => {
  assertEqual(normaliseName("The Acme Trading Co. Ltd"), "ACME TRADING", "core tokens only");
  assertEqual(normaliseName("ACME & SONS PLC"), "ACME AND SONS", "& expands, PLC dropped");
});
test("normalisation folds letters that do not decompose, as the register matcher does (RS-06)", () => {
  assertEqual(normaliseName("A.P. Møller - Mærsk A/S"), "A P MOLLER MAERSK A S", "Ø and Æ folded, not deleted");
  assertEqual(nameScore("Bjørn Borg AB", "BJORN BORG AB"), 1, "the same name with and without the stroke");
  assertEqual(nameScore("Nestlé S.A.", "NESTLE SA"), nameScore("Nestle S.A.", "NESTLE SA"), "an accent changes nothing");
});
test("scoring is 1 for equivalent names and low for unrelated", () => {
  assertEqual(nameScore("Acme Trading Limited", "ACME TRADING LTD"), 1, "same core -> 1");
  assert(nameScore("Acme Trading", "Globex Industries") < 0.5, "unrelated -> low");
});
test("a conflicting legal form (Ltd vs Inc) is penalised below the 0.9 accept threshold", () => {
  assert(nameScore("Acme Ltd", "Acme Inc") < 0.9, "a UK Ltd and a US Inc are not treated as one entity");
  assertEqual(nameScore("Acme Ltd", "Acme Limited"), 1, "same-jurisdiction forms still match");
  assert(nameScore("Acme Ltd", "Acme") > 0.9, "a form on only one side is no signal, still matches");
});

suite("gleif / resolution");

export async function registerGleifTests(): Promise<void> {
  // Deterministic CH path: exactly one CH-registered LEI -> accepted.
  const chFetch = (async () =>
    jsonRes(200, { data: [item("2138001234567890ABCD", "ACME TRADING LIMITED")], meta: { pagination: { total: 1 } } })) as unknown as typeof fetch;
  const chHit = await resolveLei("Acme Trading Ltd", { chNumber: "01234567", fetchImpl: chFetch });

  // CH path with two hits -> not deterministic -> falls through to name path (also 2) -> abstain.
  const twoFetch = (async () =>
    jsonRes(200, { data: [item("A", "ACME TRADING LIMITED"), item("B", "ACME TRADING (UK) LIMITED")], meta: { pagination: { total: 2 } } })) as unknown as typeof fetch;
  const ambiguous = await resolveLei("Acme Trading", { chNumber: "07654321", fetchImpl: twoFetch });

  // Name path: a strong single match -> accepted.
  const nameFetch = (async () =>
    jsonRes(200, { data: [item("2138009999999999ZZZZ", "GLOBEX INDUSTRIES PLC")], meta: { pagination: { total: 1 } } })) as unknown as typeof fetch;
  const nameHit = await resolveLei("Globex Industries", { country: "GB", fetchImpl: nameFetch });

  // Name path: two near-equal candidates -> abstain (margin < 0.05).
  const closeFetch = (async () =>
    jsonRes(200, { data: [item("A", "NORTHWIND TRADING LIMITED"), item("B", "NORTHWIND TRADING LIMITED")], meta: { pagination: { total: 2 } } })) as unknown as typeof fetch;
  const tooClose = await resolveLei("Northwind Trading", { country: "GB", fetchImpl: closeFetch });

  suite("gleif / resolution");

  test("a single CH-registered LEI resolves deterministically", () => {
    assert(!!chHit && chHit.lei === "2138001234567890ABCD", "resolved the LEI");
  });
  test("two CH candidates do not resolve (abstain, never mis-link)", () => {
    assertEqual(ambiguous, null, "ambiguous -> null");
  });
  test("a strong single name match resolves", () => {
    assert(!!nameHit && nameHit.legalName.includes("GLOBEX"), "resolved by name");
  });
  test("two near-equal name candidates abstain", () => {
    assertEqual(tooClose, null, "ambiguous top-two -> null");
  });
}
