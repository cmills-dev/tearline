// test/wackySheets.test.ts
// Accuracy regression across 30 deliberately-odd client tear sheets (test/fixtures/wackySheets.ts).
// It guards the two properties that make the induction engine trustworthy on real-world variety:
// it never fabricates a mapping (a niche "non-negotiable" line must never become a financial
// field), and it catches the genuine financial lines it should, whatever the client calls them.
// Currency and section detection are checked too. Ground truth encodes the engine's honest
// nuance boundaries (e.g. a single-space negative value, or CHF which is not a detected symbol),
// so a change that quietly widened or narrowed behaviour will trip this suite.

import { suite, test, assert, assertEqual } from "./harness";
import { WACKY_SHEETS } from "./fixtures/wackySheets";
import { induceClientSpec } from "../lib/clientspec/induce";

suite("clientspec / 30 wacky sheets");

for (const s of WACKY_SHEETS) {
  const { spec } = induceClientSpec({ text: s.text, name: s.name }, "tenant-wacky");
  const keys = spec.fields.map((f) => f.key);
  const labels = spec.fields.map((f) => f.label.toLowerCase());

  test(`${s.name}: no niche line is fabricated into a field`, () => {
    for (const ab of s.expectAbstain) {
      assert(!labels.some((l) => l.includes(ab.toLowerCase())), `niche line "${ab}" was mapped to a concept`);
    }
  });

  test(`${s.name}: maps every expected financial concept`, () => {
    for (const k of s.expectMapped) assert(keys.includes(k), `expected concept "${k}" was not mapped`);
  });

  test(`${s.name}: binds nothing outside the expected set`, () => {
    for (const k of keys) assert(s.expectMapped.includes(k), `unexpected binding to "${k}"`);
  });

  test(`${s.name}: detects currency ${s.currency}`, () => {
    assertEqual(spec.styleTokens.currencyDefault, s.currency, "currency mismatch");
  });

  if (s.skeletonHas) {
    test(`${s.name}: detects its section headings`, () => {
      for (const h of s.skeletonHas!) assert(spec.skeleton.includes(h), `section "${h}" not detected`);
    });
  }
}
