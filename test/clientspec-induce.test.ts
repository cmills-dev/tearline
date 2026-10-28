// test/clientspec-induce.test.ts
// The Module 1 induction engine: an example house sheet in, a ClientSpec plus honest
// abstentions out. These cases pin the doctrine that matters: a known label binds to its
// concept while keeping the client's own wording, an unknown label is surfaced (never
// guessed onto a near-miss), currency and section skeleton are read from the sheet, and the
// produced spec satisfies the frozen contract validator. In-memory, no network.

import { suite, test, assert, assertEqual } from "./harness";
import { induceClientSpec } from "../lib/clientspec/induce";
import { DEFAULT_SKELETON } from "../lib/clientspec/concepts";
import { validateClientSpec } from "../lib/contracts/validate";

// A representative pasted sheet: two section banners, mapped metrics with the client's own
// wording, a sterling figure, and one house-specific KPI the dictionary does not know.
const SAMPLE = [
  "Acme house sheet Q3",
  "FINANCIALS",
  "Turnover              40,000",
  "Adjusted EBITDA       1,240",
  "Bespoke KPI 42        9,999",
  "Leverage & liquidity",
  "Net debt              £3,200",
  "Net leverage          2.4x",
].join("\n");

suite("clientspec / induction");

export async function registerClientSpecInduceTests(): Promise<void> {
  const induced = induceClientSpec({ name: "Acme house sheet", text: SAMPLE }, "acme");

  test("a known label maps to its concept and keeps the client's own wording", () => {
    const ebitda = induced.spec.fields.find((f) => f.key === "ebitda");
    assert(!!ebitda, "the Adjusted EBITDA row bound to the ebitda concept");
    assertEqual(ebitda!.label, "Adjusted EBITDA", "the client's exact label is preserved, not canonicalised");
    assertEqual(ebitda!.ontologyConcept, "ebitda", "the field is bound to the ontology concept");
    assertEqual(ebitda!.required, false, "induced fields are advisory, not blocking, until an analyst confirms");
    assert(induced.spec.fields.some((f) => f.key === "turnover"), "Turnover mapped too");
    assertEqual(induced.mappedCount, induced.spec.fields.length, "mappedCount agrees with the bound fields");
  });

  test("an unknown label is surfaced in unmapped, never guessed into a field", () => {
    assert(induced.unmapped.some((u) => u.includes("Bespoke KPI")), "the house-specific KPI is recorded for review");
    assert(!induced.spec.fields.some((f) => f.label.includes("Bespoke KPI")), "it is never bound to an approximate concept");
  });

  test("currency is read from the figures (sterling here, dollars elsewhere)", () => {
    assertEqual(induced.spec.styleTokens.currencyDefault, "GBP", "a £ figure fixes the house currency to GBP");
    const usd = induceClientSpec({ text: "Turnover     $52,000" }, "dollar-co");
    assertEqual(usd.spec.styleTokens.currencyDefault, "USD", "a $ figure fixes the house currency to USD");
  });

  test("section headings are detected into the skeleton, with a default fallback", () => {
    assert(induced.spec.skeleton.includes("FINANCIALS"), "an ALL-CAPS banner is a section heading");
    assert(induced.spec.skeleton.includes("Leverage & liquidity"), "a named skeleton slot is detected");
    const plain = induceClientSpec({ text: "Turnover     40,000\nAdjusted EBITDA   1,240" }, "plain-co");
    assertEqual(
      plain.spec.skeleton.join(" | "),
      [...DEFAULT_SKELETON].join(" | "),
      "with no headings on the sheet, the default skeleton is used"
    );
  });

  test("a row whose label starts with a digit is not silently dropped", () => {
    // "1st Lien Term Loan" is a real field label; the value column is a whitespace-separated figure.
    const r = induceClientSpec({ text: "1st Lien Term Loan     125,000" }, "digit-co");
    const kept = r.spec.fields.some((f) => /1st lien/i.test(f.label)) || r.unmapped.some((u) => /1st lien/i.test(u));
    assert(kept, "the digit-leading row is surfaced (mapped or as an honest unmapped label), never dropped");
    assert(!r.unmapped.includes(""), "no empty-label abstention is produced");
  });

  test("the induced spec satisfies the frozen ClientSpec contract", () => {
    const result = validateClientSpec(induced.spec);
    assert(result.ok, `spec should validate, errors: ${result.errors.join("; ")}`);
  });
}
