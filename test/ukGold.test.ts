// test/ukGold.test.ts
// The UK gold set's own integrity (WP-BE17). No network, no model call, no engine.
//
// It checks the answer key, not the engine: every structured tie recomputes to what it says,
// every figure a person is said to have checked carries that person's check as data, the
// provisional claude-checked label never counts as a person's check, and the coverage the
// backlog asked for (three figures a filing, facilities on four, the two named cases) holds.

import { suite, test, assert, assertEqual } from "./harness";
import { FACILITY_TYPES } from "../lib/vision/types";
import { UK_GOLD, UK_TIES, PERSON_CHECKED, isPersonChecked, STATUS_MEANING, type UkTie } from "../eval/gold/uk";

const round = (n: number) => Math.round(n * 1e6) / 1e6;
const tieHolds = (t: UkTie) =>
  t.identities.every(({ terms, total }) => {
    const sum = terms.reduce((s, [, v]) => s + v, 0);
    const tolerance = (t.unit / 2) * (terms.length + 1);
    return Math.abs(round(sum - total[1])) <= tolerance + 1e-9;
  });

suite("ukGold / ties");

for (const t of UK_TIES) {
  test(`${t.id}: the arithmetic ${t.holds ? "holds" : "does not hold"}, as recorded`, () => {
    assertEqual(tieHolds(t), t.holds, `${t.id} recomputed`);
  });
}

test("tie ids are unique and every tie names a real case", () => {
  const ids = UK_TIES.map((t) => t.id);
  assertEqual(new Set(ids).size, ids.length, "unique ids");
  for (const t of UK_TIES) assert(UK_GOLD.some((c) => c.key === t.caseKey), `${t.id} case ${t.caseKey}`);
});

test("every tie id a figure cites exists, in the same case", () => {
  for (const c of UK_GOLD) {
    for (const f of c.figures) {
      for (const ref of f.ties ?? []) {
        if (!/^[a-z0-9-]+$/.test(ref)) continue; // a part-1 description
        const t = UK_TIES.find((x) => x.id === ref);
        assert(t, `${c.key} ${f.metric} cites ${ref}`);
        assertEqual(t!.caseKey, c.key, `${ref} belongs to ${c.key}`);
      }
    }
  }
});

test("a tie-checked figure cites at least one tie that holds", () => {
  for (const c of UK_GOLD) {
    for (const f of c.figures.filter((x) => x.status === "tie-checked")) {
      const refs = f.ties ?? [];
      const ok = refs.some((r) => !/^[a-z0-9-]+$/.test(r) || UK_TIES.find((t) => t.id === r)?.holds);
      assert(ok, `${c.key} ${f.metric} has a holding tie`);
    }
  }
});

suite("ukGold / labels");

test("claude-checked is not a person's check, and the data says so", () => {
  assert(!PERSON_CHECKED.includes("claude-checked"), "claude-checked is not in PERSON_CHECKED");
  assert(!isPersonChecked({ status: "claude-checked" }), "isPersonChecked is false for claude-checked");
  assert(STATUS_MEANING["claude-checked"].startsWith("PROVISIONAL"), "its meaning says provisional");
});

test("every claude-checked figure is a spot-check figure carrying both machine checks and no person's", () => {
  const all = UK_GOLD.flatMap((c) => c.figures.map((f) => ({ c, f })));
  const claude = all.filter(({ f }) => f.status === "claude-checked");
  for (const { c, f } of claude) {
    assert(f.spotCheck !== undefined, `${c.key} ${f.metric} has a spot-check row`);
    const by = (f.checks ?? []).map((k) => k.by).sort().join(",");
    assertEqual(by, "apple-vision-ocr,claude-visual", `${c.key} ${f.metric} checks`);
    assert((f.checks ?? []).every((k) => !k.person), `${c.key} ${f.metric} has no person's check`);
  }
  const rows = all.filter(({ f }) => f.spotCheck !== undefined).map(({ f }) => f.spotCheck!).sort((a, b) => a - b);
  assertEqual(rows.join(","), "1,2,3,4,5,6,7,8,9,10", "the ten spot-check rows are each keyed once");
});

test("a figure may only claim a person's check if that person's check is in its data", () => {
  for (const c of UK_GOLD) {
    for (const f of c.figures.filter(isPersonChecked)) {
      assert((f.checks ?? []).some((k) => k.by === "cam" && k.person), `${c.key} ${f.metric} carries Cam's check`);
    }
    for (const f of c.figures) {
      if ((f.checks ?? []).some((k) => k.person)) assert(isPersonChecked(f), `${c.key} ${f.metric}: a person's check sets a person's status`);
    }
  }
});

test("every spot-check figure is claude-checked or checked by Cam, never a bare candidate", () => {
  for (const c of UK_GOLD) {
    for (const f of c.figures.filter((x) => x.spotCheck !== undefined)) {
      assert(f.status === "claude-checked" || isPersonChecked(f), `${c.key} row ${f.spotCheck} is ${f.status}`);
    }
  }
});

suite("ukGold / coverage");

test("at least three figures on every filing, each agent-read one with page, printed text and scale", () => {
  for (const c of UK_GOLD) {
    assert(c.figures.length >= 3, `${c.key} has ${c.figures.length}`);
    for (const f of c.figures.filter((x) => x.method === "agent-read")) {
      assert(f.pdfPage && f.printedText && f.scaleCaption, `${c.key} ${f.metric} page, text and scale`);
      assert(typeof f.value === "number" || f.value === "ABSTAIN", `${c.key} ${f.metric} value`);
      if (f.document) assert(c.parent?.file === f.document, `${c.key} ${f.metric} document ${f.document} is the parent file`);
    }
  }
});

test("facilities from the debt notes on at least four filings, each quoted and typed", () => {
  const withFacilities = UK_GOLD.filter((c) => (c.facilities ?? []).length > 0);
  assert(withFacilities.length >= 4, `${withFacilities.length} filings`);
  for (const c of withFacilities) {
    for (const fa of c.facilities!) {
      assert((FACILITY_TYPES as readonly string[]).includes(fa.type), `${c.key} ${fa.nameAsPrinted} type ${fa.type}`);
      assert(fa.pdfPage > 0 && fa.quote.length > 20, `${c.key} ${fa.nameAsPrinted} page and quote`);
      assert(!isPersonChecked(fa), `${c.key} ${fa.nameAsPrinted} is not claimed as checked by a person`);
    }
  }
});

test("Bristol Water: preference shares apart from borrowings, and interest payable abstains", () => {
  const bw = UK_GOLD.find((c) => c.key === "bristol-water-2026")!;
  const m = (k: string) => bw.figures.find((f) => f.metric === k);
  assertEqual(m("preference_shares")?.value, -12_500_000, "preference shares (12.5)");
  assertEqual(m("borrowings_after_one_year")?.value, -1_600_000, "borrowings exclude them");
  assertEqual(m("interest_payable")?.value, "ABSTAIN", "interest payable is only the preference dividend");
  assertEqual(m("preference_dividends")?.value, -1_100_000, "the dividend is keyed on its own");
});

test("the IFRS 16 case: Topps' lease lines are keyed both ways and add to the note total", () => {
  const tt = UK_GOLD.find((c) => c.key === "topps-tiles-2025")!;
  const v = (k: string) => tt.figures.find((f) => f.metric === k)?.value as number;
  assertEqual(-v("lease_liabilities_non_current") - v("lease_liabilities_current"), v("lease_liabilities_total"), "83,010 + 16,782 = 99,792");
  assert(v("lease_liabilities_total") > 9 * -v("borrowings_after_one_year"), "leases dwarf the bank debt");
});
