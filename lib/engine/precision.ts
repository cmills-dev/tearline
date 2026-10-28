// lib/engine/precision.ts
// Printed precision: what one unit of the last printed digit is worth, in the fact's own
// currency units. A figure printed "12.5" under "£m" is worth £100,000 per last digit, so it
// may be out by £50,000 from rounding alone. An identity over three such figures may be out
// by the sum of their halves and no more. verify.ts turns this into its tolerance (QA05 skip 2).
//
// Where it comes from, best first:
//   decimals  the iXBRL / xBRL-JSON `decimals` attribute the filer declared ("-6" is £1m,
//             "0" is £1, "INF" is exact).
//   printed   the decimal places printed in the figure, times the scale caption it sits under.
//   value     no printed figure and no decimals (SEC Company Facts): the largest power of ten
//             that divides the value, capped at a million. It can only over-state the true
//             precision, never under-state it, so verify.ts also caps its tolerance at the old
//             flat 0.5% when any input is inferred this way.

import type { FactPrecision } from "./types";

// Above this a round figure says nothing about rounding: a filer printing in millions files
// 2,000,000,000, and so does one printing in thousands.
const MAX_VALUE_PRECISION = 1_000_000;

// From an XBRL `decimals` attribute. Undefined when absent or unreadable.
export function precisionFromDecimals(decimals: unknown): FactPrecision | undefined {
  if (decimals === undefined || decimals === null || decimals === "") return undefined;
  if (String(decimals).trim().toUpperCase() === "INF") return { unit: 0, basis: "decimals" };
  const d = Number(decimals);
  if (!Number.isInteger(d)) return undefined;
  return { unit: Math.pow(10, -d), basis: "decimals" };
}

// The number of decimal places printed in a figure ("(1,234.56)" -> 2, "1,234" -> 0).
export function printedDecimals(figureText: string): number {
  const m = figureText.match(/\d[\d,]*\.(\d+)/);
  return m ? m[1].length : 0;
}

// From the figure as printed and the scale it sits under (1 for pounds, 1000 for £'000).
export function precisionFromPrinted(figureText: string, scale: number): FactPrecision | undefined {
  if (!Number.isFinite(scale) || scale <= 0) return undefined;
  return { unit: scale * Math.pow(10, -printedDecimals(figureText)), basis: "printed" };
}

// From the value alone: the largest power of ten, up to a million, that divides it.
export function precisionFromValue(value: number): FactPrecision | undefined {
  if (!Number.isFinite(value)) return undefined;
  if (!Number.isInteger(value)) return { unit: 0.01, basis: "value" };
  let unit = 1;
  while (unit < MAX_VALUE_PRECISION && value % (unit * 10) === 0) unit *= 10;
  return { unit, basis: "value" };
}

const WEAKEST: FactPrecision["basis"][] = ["value", "printed", "decimals"];

// A line that is the sum of two tagged figures may be out by both their roundings. The basis
// is the weaker of the two. Undefined if either part has none.
export function addPrecision(a: FactPrecision | undefined, b: FactPrecision | undefined): FactPrecision | undefined {
  if (!a || !b) return undefined;
  const basis = WEAKEST.find((w) => w === a.basis || w === b.basis)!;
  return { unit: a.unit + b.unit, basis };
}
