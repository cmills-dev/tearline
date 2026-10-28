// test/screen.test.ts
// Engine B screen: deterministic ranking, correct hard-filter exclusions, and every
// rendered rationale is ProseGate-clean.

import { screen } from "../lib/engineB/screen";
import { getMandatePreset, MANDATE_PRESETS } from "../lib/engineB/mandate";
import { listUniverse } from "../lib/engineB/universe";
import { prosegate } from "../lib/engine/prosegate";
import { suite, test, assert, assertEqual } from "./harness";

suite("Engine B screen / universe");

test("universe reuses meridian and redacta and is clearly synthetic", () => {
  const u = listUniverse();
  assert(u.some((m) => m.key === "meridian"), "meridian present");
  assert(u.some((m) => m.key === "redacta"), "redacta present");
  assert(u.length >= 12 && u.length <= 16, "c. 12-16 members");
  assert(u.every((m) => m.synthetic === true), "every member flagged synthetic");
});

test("leverage ties to net debt / EBITDA for every member with both", () => {
  for (const m of listUniverse()) {
    if (m.netDebt.value !== null && m.ebitda.value !== null && m.leverage.value !== null) {
      const expected = Math.round((m.netDebt.value / m.ebitda.value) * 100) / 100;
      assertEqual(m.leverage.value, expected, `${m.key} leverage ties`);
    }
  }
});

suite("Engine B screen / UK mid-market refinancing wall");

const refi = getMandatePreset("uk-midmarket-refi-wall")!;
const out = screen(refi);

test("determinism: same mandate, same ranking twice", () => {
  const a = screen(refi).ranked.map((r) => `${r.member.key}:${r.score}`).join("|");
  const b = screen(refi).ranked.map((r) => `${r.member.key}:${r.score}`).join("|");
  assertEqual(a, b, "identical output");
});

test("hard filter excludes non-UK names with a logged reason", () => {
  const excludedKeys = out.excluded.map((r) => r.member.key);
  assert(excludedKeys.includes("calder"), "calder (Europe) excluded");
  assert(excludedKeys.includes("quantum"), "quantum (North America) excluded");
  for (const r of out.excluded) {
    assert(r.exclusion !== undefined, "exclusion is logged");
    assert(r.exclusion!.reason.length > 0, "exclusion carries a reason");
    assert(!r.included, "excluded members are not included");
  }
});

test("top result is Pennine at 100, and it beats a partial-fit UK name", () => {
  assertEqual(out.ranked[0].member.key, "pennine", "top name");
  assertEqual(out.ranked[0].score, 100, "perfect fit score");
  const lowell = out.ranked.find((r) => r.member.key === "lowell")!;
  assert(out.ranked[0].score > lowell.score, "Pennine outranks Lowell");
});

test("ranking is sorted by score descending", () => {
  for (let i = 1; i < out.ranked.length; i++) {
    assert(out.ranked[i - 1].score >= out.ranked[i].score, "monotonic non-increasing");
  }
});

test("top result carries concrete typed evidence tied to facts", () => {
  const top = out.ranked[0];
  const kinds = new Set(top.reasons.map((r) => r.kind));
  assert(kinds.has("sector"), "has a sector reason");
  assert(kinds.has("size"), "has a size reason");
  assert(kinds.has("leverage"), "has a leverage reason");
  assert(kinds.has("situation"), "has at least one situation reason");
  const sizeReason = top.reasons.find((r) => r.kind === "size")!;
  assertEqual(sizeReason.factMetric, "ebitda", "size reason points at the EBITDA fact");
});

test("every rendered rationale passes ProseGate", () => {
  for (const preset of MANDATE_PRESETS) {
    for (const r of screen(preset).ranked) {
      assert(!!r.rationale, `${r.member.key} has a rationale`);
      const gate = prosegate(r.rationale!);
      assert(gate.clean, `${r.member.key} rationale clean: ${JSON.stringify(gate.violations)}`);
    }
  }
});

test("every rendered evidence reason passes ProseGate", () => {
  for (const preset of MANDATE_PRESETS) {
    const s = screen(preset);
    for (const r of [...s.ranked, ...s.excluded]) {
      for (const reason of r.reasons) {
        assert(prosegate(reason.text).clean, `reason clean: "${reason.text}"`);
      }
    }
  }
});

suite("Engine B screen / sponsor-owned software preset");

test("software preset excludes non-software and keeps sponsor-owned software", () => {
  const sw = getMandatePreset("sponsor-software-levered")!;
  const s = screen(sw);
  assert(s.ranked.every((r) => r.member.sector === "software"), "only software survives");
  assert(s.excluded.every((r) => r.exclusion!.failedFilter === "sector"), "excluded on sector");
  const keys = s.ranked.map((r) => r.member.key);
  assert(keys.includes("helios"), "helios (levered sponsor software) included");
  assert(keys.includes("calder"), "calder included (geography open)");
});
