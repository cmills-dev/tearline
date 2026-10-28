// test/model.test.ts
// The Excel model build. Its whole reason to exist is that the derived metrics are
// LIVE FORMULAS over the reported inputs, and that abstained inputs stay blank rather
// than being invented. Building the workbook is synchronous (only writeBuffer is
// async), so these cases register on import like the other synchronous suites; no
// async registrar is needed.

import type ExcelJS from "exceljs";
import { assembleModelWorkbook } from "../lib/model/buildWorkbook";
import { tearSheetForKey } from "../lib/engine/pipeline";
import { suite, test, assert, assertEqual } from "./harness";

function ws(wb: ExcelJS.Workbook, name: string): ExcelJS.Worksheet {
  const sheet = wb.getWorksheet(name);
  if (!sheet) throw new Error(`worksheet ${name} missing`);
  return sheet;
}

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || v === "";
}

function formulaOf(v: unknown): string | null {
  if (typeof v === "object" && v !== null && "formula" in v) {
    const f = (v as { formula: unknown }).formula;
    return typeof f === "string" ? f : null;
  }
  return null;
}

suite("model / workbook build (meridian)");

const meridian = tearSheetForKey("meridian");

test("builds the seven model sheets", () => {
  assert(!!meridian, "meridian tear sheet resolves");
  const wb = assembleModelWorkbook(meridian!);
  const names = wb.worksheets.map((w) => w.name);
  for (const expected of ["Cover", "Inputs", "Model", "Capital structure", "Facilities", "Sources", "Provenance"]) {
    assert(names.includes(expected), `sheet present: ${expected} (got ${names.join(", ")})`);
  }
  assertEqual(wb.worksheets.length, 7, "exactly seven sheets");
});

test("Inputs EBIT and D&A land as reported NUMBERS", () => {
  const wb = assembleModelWorkbook(meridian!);
  const inputs = ws(wb, "Inputs");
  // Row 3 = operating profit (EBIT), row 4 = depreciation & amortisation. Column B.
  assertEqual(typeof inputs.getCell("B3").value, "number", "EBIT is a number cell");
  assertEqual(inputs.getCell("B3").value, 6_400_000, "EBIT value from the fixture");
  assertEqual(typeof inputs.getCell("B4").value, "number", "D&A is a number cell");
  assertEqual(inputs.getCell("B4").value, 2_300_000, "D&A value from the fixture");
});

test("Model EBITDA is a live FORMULA over the inputs, not a hardcoded number", () => {
  const wb = assembleModelWorkbook(meridian!);
  const model = ws(wb, "Model");
  const v = model.getCell("B2").value; // row 2 = EBITDA (latest column)
  const formula = formulaOf(v);
  assert(formula !== null, "EBITDA cell carries a formula object");
  assert(formula!.includes("+"), `EBITDA formula adds its inputs (got ${formula})`);
  assert(formula!.includes("Inputs!"), "EBITDA formula references the Inputs sheet");
  assertEqual(typeof v, "object", "EBITDA is not a plain number");
});

test("Net debt and leverage are also formulas", () => {
  const wb = assembleModelWorkbook(meridian!);
  const model = ws(wb, "Model");
  // Row 3 is net debt including leases (blank here: this synthetic sheet carries no lease line),
  // row 4 net debt excluding leases, row 5 leverage (WP-BE23).
  assert(formulaOf(model.getCell("B4").value) !== null, "net debt excluding leases is a formula");
  const lev = formulaOf(model.getCell("B5").value);
  assert(lev !== null && lev.includes("B4/B2"), "leverage divides net debt excluding leases by EBITDA when no lease line is on the sheet");
});

suite("model / abstained inputs stay blank (redacta)");

const redacta = tearSheetForKey("redacta");

test("an unreported input leaves its Inputs number cell empty and the dependent formula blank", () => {
  assert(!!redacta, "redacta tear sheet resolves");
  const wb = assembleModelWorkbook(redacta!);
  const inputs = ws(wb, "Inputs");
  // Redacta files no depreciation & amortisation split, so the D&A input (row 4) is
  // not reported: its number cell must be blank, never invented.
  assert(isBlank(inputs.getCell("B4").value), "D&A input cell is blank for redacta");
  // With no D&A, EBITDA cannot be built, so the derived EBITDA cell must be blank too.
  const model = ws(wb, "Model");
  assert(isBlank(model.getCell("B2").value), "EBITDA formula is left blank when an input is missing");
  // Net debt still resolves (borrowings and cash are both reported), proving the guard
  // is per-metric and not a blanket suppression.
  assert(formulaOf(model.getCell("B4").value) !== null, "net debt still resolves for redacta");
});
