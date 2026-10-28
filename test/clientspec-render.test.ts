// test/clientspec-render.test.ts
// Tests for the ClientSpec renderer: it serves a client's house-sheet fields from a real
// FactManifest, formats accepted values, and abstains honestly where a fact is missing or
// sits below the client's resolution floor.

import { suite, test, assert, assertEqual } from "./harness";
import { buildManifest } from "../lib/engine/buildManifest";
import { meridian } from "../lib/sources/fixtures/meridian";
import { renderAgainstSpec } from "../lib/clientspec/render";
import type { ClientSpec, ClientSpecField, ClientStyleTokens } from "../lib/contracts/clientSpec";

const styleTokens: ClientStyleTokens = {
  voice: "analyst-understated",
  numberStyle: "tabular",
  dateFormat: "D MMM YYYY",
  currencyDefault: "GBP",
};

function field(overrides: Partial<ClientSpecField> & { key: string; label: string }): ClientSpecField {
  return {
    ontologyConcept: overrides.key,
    required: false,
    ...overrides,
  };
}

function spec(fields: ClientSpecField[], skeleton: string[], name = "Test house sheet"): ClientSpec {
  return {
    contractVersion: "0",
    clientId: "client-test",
    version: 3,
    name,
    fields,
    styleTokens,
    skeleton,
    inducedFrom: ["fixture"],
    createdAt: "2026-08-19",
  };
}

const manifest = buildManifest(meridian);

suite("clientspec / render");

test("a present fact renders a formatted value with the client's label", () => {
  const s = spec([field({ key: "turnover", label: "Group revenue", format: "currency" })], ["Financials"]);
  const sheet = renderAgainstSpec(s, manifest);

  const f = sheet.sections[0].fields[0];
  assertEqual(f.label, "Group revenue", "uses the client's own label");
  assertEqual(f.abstained, false, "a present fact does not abstain");
  assertEqual(f.belowFloor, false, "a present fact is not below floor");
  assertEqual(f.value, "£48.2m", "turnover renders in millions with the GBP symbol");
  assertEqual(f.rung, "R1", "reported turnover is R1");
  assert(!!f.factId, "a served field carries the fact id it resolved from");
  assertEqual(sheet.entityName, "PROJECT MERIDIAN (illustrative)", "carries the entity name");
  assertEqual(sheet.specVersion, 3, "carries the spec version");
});

test("a field with no matching fact abstains", () => {
  const s = spec([field({ key: "sector", label: "Sector" })], ["Header"]);
  const sheet = renderAgainstSpec(s, manifest);

  const f = sheet.sections[0].fields[0];
  assertEqual(f.abstained, true, "no fact means an honest abstain");
  assertEqual(f.value, null, "an abstained field shows no value");
  assertEqual(f.rung, null, "an abstained field carries no rung");
  assertEqual(f.belowFloor, false, "absence is not a below-floor withholding");
});

test("a fact below the field's resolution floor is withheld (belowFloor)", () => {
  // EBITDA on Meridian is synthesised (R2). A field that will only accept R1 must not show it.
  const s = spec([field({ key: "ebitda", label: "Adjusted EBITDA", format: "currency", resolutionFloor: "R1" })], ["Financials"]);
  const sheet = renderAgainstSpec(s, manifest);

  const f = sheet.sections[0].fields[0];
  assertEqual(f.abstained, true, "a below-floor fact abstains rather than showing");
  assertEqual(f.belowFloor, true, "the fact existed but sat below the client's floor");
  assertEqual(f.value, null, "a value below the floor is never shown");
  assert(f.rung !== null && f.rung !== "R1", "the withheld fact's rung is worse than the R1 floor");
});

test("an accepted fact within its floor still renders", () => {
  // Same EBITDA, but a client whose floor tolerates R2 accepts it.
  const s = spec([field({ key: "ebitda", label: "Adjusted EBITDA", format: "currency", resolutionFloor: "R2" })], ["Financials"]);
  const sheet = renderAgainstSpec(s, manifest);

  const f = sheet.sections[0].fields[0];
  assertEqual(f.abstained, false, "an R2 fact meets an R2 floor");
  assertEqual(f.belowFloor, false, "not below floor");
  assertEqual(f.value, "£8.7m", "EBITDA renders in millions");
});

test("sections come out in skeleton order", () => {
  const s = spec(
    [
      field({ key: "turnover", label: "Turnover", format: "currency" }), // Financials
      field({ key: "leverage", label: "Net leverage", format: "ratio" }), // Leverage & liquidity
    ],
    ["Leverage & liquidity", "Financials"]
  );
  const sheet = renderAgainstSpec(s, manifest);

  assertEqual(sheet.sections.length, 2, "two non-empty sections");
  assertEqual(sheet.sections[0].title, "Leverage & liquidity", "skeleton order is honoured, not field order");
  assertEqual(sheet.sections[1].title, "Financials", "second section follows the skeleton");
});

test("a required field that abstains blocks the sheet and is listed", () => {
  const s = spec(
    [
      field({ key: "turnover", label: "Turnover", format: "currency" }),
      field({ key: "sector", label: "Sector", required: true }), // no fact -> abstains
    ],
    ["Header", "Financials"]
  );
  const sheet = renderAgainstSpec(s, manifest);

  assertEqual(sheet.blocked, true, "a required abstain blocks the sheet");
  assertEqual(sheet.blockingFields.length, 1, "one blocking field");
  assertEqual(sheet.blockingFields[0], "Sector", "the blocking field is listed by its client label");
});
