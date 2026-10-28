// test/llm.test.ts
// Tests for the provider-neutral parsing engine (lib/llm/*).
//
// These tests make no network calls. They drive the exact parse + doctrine-guard path that
// extractFactsFromDocument runs internally, using its exported synchronous helpers plus
// the deterministic MockProvider, so they stay fast and reliable while still covering the
// real logic end to end. (The harness awaits async test bodies, so async tests are fine.)

import { suite, test, assert, assertEqual } from "./harness";
import { getProvider } from "../lib/llm/config";
import {
  valueGroundedInQuote,
  parseExtractions,
  applyDoctrineGuard,
  stripCodeFences,
  quoteIsAnchored,
  toFactDrafts,
  signGrounded,
  scaleGrounded,
} from "../lib/llm/extract";
import { MockProvider } from "../lib/llm/mockProvider";

suite("llm/config");

test("getProvider returns null when LLM_PROVIDER is unset", () => {
  const provider = getProvider({ provider: "none", model: "", maxTokens: 2048 });
  assertEqual(provider, null, "unset/none provider should disable the engine");
});

test("getProvider returns null for the 'none' kind", () => {
  const provider = getProvider({ provider: "none", model: "x", apiKey: "k", maxTokens: 2048 });
  assertEqual(provider, null, "'none' should yield a null provider");
});

test("getProvider builds a real provider when configured", () => {
  const provider = getProvider({
    provider: "anthropic",
    model: "claude-opus-5",
    apiKey: "test-key",
    maxTokens: 1024,
  });
  assert(provider !== null, "anthropic config should build a provider");
  assertEqual(provider?.name, "anthropic", "provider name should be anthropic");
});

suite("llm/extract");

const DOC = [
  "MERIDIAN HOLDINGS LIMITED",
  "Consolidated income statement for the year ended 31 December 2024.",
  "Revenue for the year was 152,300 thousand pounds.",
  "Operating profit was 24,900 thousand pounds.",
].join("\n");

test("parses valid JSON and returns anchored extractions", () => {
  const modelJson = JSON.stringify({
    extractions: [
      {
        metric: "revenue",
        valueText: "152,300",
        unit: "GBP",
        sourceQuote: "Revenue for the year was 152,300 thousand pounds.",
      },
      {
        metric: "operatingProfit",
        valueText: "24,900",
        unit: "GBP",
        sourceQuote: "Operating profit was 24,900 thousand pounds.",
      },
    ],
  });

  const parsed = parseExtractions(modelJson);
  const survivors = applyDoctrineGuard(parsed, DOC);

  assertEqual(survivors.length, 2, "both anchored extractions should survive");
  assertEqual(survivors[0].metric, "revenue", "first metric should be revenue");
  assertEqual(survivors[0].valueText, "152,300", "value text should be preserved");
  assertEqual(survivors[0].unit, "GBP", "unit should be preserved");
});

test("doctrine guard DROPS an extraction whose sourceQuote is absent from the document", () => {
  const modelJson = JSON.stringify({
    extractions: [
      {
        metric: "revenue",
        valueText: "152,300",
        sourceQuote: "Revenue for the year was 152,300 thousand pounds.",
      },
      {
        // Fabricated: this figure and quote appear nowhere in DOC.
        metric: "ebitda",
        valueText: "40,000",
        sourceQuote: "EBITDA for the year was 40,000 thousand pounds.",
      },
    ],
  });

  const parsed = parseExtractions(modelJson);
  assertEqual(parsed.length, 2, "both candidates should parse before the guard");

  const survivors = applyDoctrineGuard(parsed, DOC);
  assertEqual(survivors.length, 1, "the unanchored (fabricated) extraction must be dropped");
  assertEqual(survivors[0].metric, "revenue", "only the anchored extraction survives");
});

test("guard DROPS a real quote whose reported value is not inside it (right quote, wrong number)", () => {
  const modelJson = JSON.stringify({
    extractions: [
      {
        // The quote is a genuine verbatim slice of DOC, but the value 99,900 is NOT in it.
        metric: "operatingProfit",
        valueText: "99,900",
        sourceQuote: "Operating profit was 24,900 thousand pounds.",
      },
    ],
  });
  const survivors = applyDoctrineGuard(parseExtractions(modelJson), DOC);
  assertEqual(survivors.length, 0, "a value whose digits are not in its own quote is dropped");
});

test("valueGroundedInQuote matches by significant digits regardless of separators/scale", () => {
  assert(valueGroundedInQuote("152,300", "Revenue was 152,300 thousand"), "commas ignored");
  assert(valueGroundedInQuote("£420m", "turnover of £420m"), "currency + scale suffix ignored");
  assert(!valueGroundedInQuote("40000", "Revenue increased over the year"), "no digits in quote -> not grounded");
  assert(!valueGroundedInQuote("no-digits", "any text"), "a value with no digits is not grounded");
});

test("quoteIsAnchored normalises whitespace and case", () => {
  assert(
    quoteIsAnchored("revenue for the year   was 152,300 THOUSAND pounds.", DOC),
    "whitespace/case-normalised quote should still anchor"
  );
  assert(!quoteIsAnchored("no such text here", DOC), "absent quote should not anchor");
  assert(!quoteIsAnchored("   ", DOC), "empty/blank quote should not anchor");
});

test("code-fence stripping works", () => {
  const fenced = "```json\n" + '{ "extractions": [] }' + "\n```";
  assertEqual(stripCodeFences(fenced), '{ "extractions": [] }', "```json fence should be stripped");

  const bareFence = "```\n" + '{ "extractions": [] }' + "\n```";
  assertEqual(stripCodeFences(bareFence), '{ "extractions": [] }', "bare ``` fence should be stripped");

  // And the parser should see through fences to the JSON within.
  const fencedList = "```json\n" + JSON.stringify([
    { metric: "revenue", valueText: "152,300", sourceQuote: "Revenue for the year was 152,300 thousand pounds." },
  ]) + "\n```";
  const parsed = parseExtractions(fencedList);
  assertEqual(parsed.length, 1, "parser should handle a fenced bare array");
  assertEqual(parsed[0].metric, "revenue", "fenced content should parse correctly");
});

test("signGrounded drops a loss reported as a positive profit, keeps a correctly-signed value", () => {
  assert(!signGrounded("5,000", "Operating loss of 5,000 thousand pounds"), "positive value against a loss quote is rejected");
  assert(signGrounded("-5,000", "Operating loss of 5,000 thousand pounds"), "a negative value matches the loss quote");
  assert(!signGrounded("5,000", "the figure of (5,000) in brackets"), "positive value against a parenthesised negative is rejected");
  assert(signGrounded("24,900", "Operating profit was 24,900 thousand pounds"), "a positive value against a profit quote is fine");
});

test("scaleGrounded drops a fabricated millions scale, keeps a supported one", () => {
  const q = "Revenue for the year was 152,300 thousand pounds.";
  assert(!scaleGrounded("GBPm", q, DOC), "a claimed millions scale with no 'million' marker anywhere is rejected");
  assert(scaleGrounded("GBPk", q, DOC), "a thousands claim is grounded by 'thousand' in the quote");
  assert(scaleGrounded("GBP", q, DOC), "no scale claimed -> nothing to ground");
  assert(scaleGrounded("GBPm", "turnover of £420m", DOC), "a millions claim IS grounded when the quote says £420m");
});

test("the full guard drops a fabricated-scale extraction end to end", () => {
  const survivors = applyDoctrineGuard(
    parseExtractions(
      JSON.stringify([
        { metric: "revenue", valueText: "152,300", unit: "GBPm", sourceQuote: "Revenue for the year was 152,300 thousand pounds." },
      ])
    ),
    DOC
  );
  assertEqual(survivors.length, 0, "a millions unit against a thousands document is not grounded");
});

test("toFactDrafts bridges surviving extractions toward the Fact/provenance shape", () => {
  const survivors = applyDoctrineGuard(
    parseExtractions(
      JSON.stringify([
        { metric: "revenue", valueText: "152,300", unit: "GBP", sourceQuote: "Revenue for the year was 152,300 thousand pounds." },
      ])
    ),
    DOC
  );
  const drafts = toFactDrafts(survivors, "Acc");
  assertEqual(drafts.length, 1, "one draft expected");
  assertEqual(drafts[0].metric, "revenue", "draft metric preserved");
  assertEqual(drafts[0].provenance.tag, "Acc", "provenance tag stamped from caller");
  assertEqual(
    drafts[0].provenance.snippet,
    "Revenue for the year was 152,300 thousand pounds.",
    "provenance snippet is the verbatim anchored quote"
  );
});

suite("llm/mockProvider");

test("MockProvider returns its scripted response and records options", async () => {
  // The harness awaits this body, so the assertions below genuinely run.
  const scripted = '{ "extractions": [] }';
  const provider = new MockProvider(scripted);
  const out = await provider.complete({ user: "hello", system: "sys" });
  assertEqual(out, scripted, "mock returns scripted string");
  assertEqual(provider.lastOptions?.user, "hello", "mock records the user prompt");
});
