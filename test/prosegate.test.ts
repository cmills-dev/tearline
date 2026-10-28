// test/prosegate.test.ts
import { prosegate, assertClean } from "../lib/engine/prosegate";
import { suite, test, assert, assertEqual, assertThrows } from "./harness";

suite("prosegate");

test("clean institutional prose passes", () => {
  const r = prosegate(
    "Net debt stands at £18.1m, putting leverage at 2.08x. The balance sheet ties."
  );
  assert(r.clean, "expected clean prose to pass");
  assertEqual(r.violations.length, 0, "no violations expected");
});

test("banned word 'genuinely' is blocked", () => {
  const r = prosegate("This is a genuinely strong credit.");
  assert(!r.clean, "should be dirty");
  assertEqual(r.violations[0].rule, "banned-word:genuinely", "rule id");
});

test("'crucial' and 'crucially' both fire", () => {
  const r = prosegate("Crucially, this is a crucial point.");
  assertEqual(r.violations.length, 2, "two crucial matches");
});

test("throat-clearing 'it's worth noting' is blocked", () => {
  assert(!prosegate("It's worth noting the gearing.").clean, "straight apostrophe");
  assert(!prosegate("It’s worth noting the gearing.").clean, "curly apostrophe");
});

test("'delve' is blocked but substrings are safe", () => {
  assert(!prosegate("We should delve into the notes.").clean, "delve blocked");
  assert(prosegate("The bedelved trench was deep.").clean, "no match inside a longer word");
});

test("'leverage' as a verb is blocked, gearing noun allowed", () => {
  assert(!prosegate("They leverage the balance sheet.").clean, "verb blocked");
  assert(prosegate("Leverage of 2.08x is comfortable.").clean, "noun allowed");
});

test("hedging words are blocked", () => {
  assert(!prosegate("This is arguably fine.").clean, "arguably");
  assert(!prosegate("Margins fell somewhat.").clean, "somewhat");
});

test("negative parallelism is blocked", () => {
  assert(!prosegate("This is not just a loan but a partnership.").clean, "not just X but Y");
  assert(!prosegate("Not only debt but equity too.").clean, "not only X but Y");
});

test("process narration is blocked", () => {
  assert(!prosegate("Let me walk through the accounts.").clean, "let me");
  assert(!prosegate("I will now summarise.").clean, "i will now");
  assert(!prosegate("I'll now summarise.").clean, "i'll now");
});

test("em-dash is blocked", () => {
  assert(!prosegate("The loan — secured — matures in 2027.").clean, "em-dash");
});

test("assertClean throws on dirty prose, returns clean prose otherwise", () => {
  assertThrows(() => assertClean("This is crucial.", "test"), "should throw");
  assertEqual(assertClean("Leverage is 2.08x.", "test"), "Leverage is 2.08x.", "passthrough");
});
