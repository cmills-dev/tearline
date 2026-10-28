// lib/format/format.ts
// Presentation-only formatting. Formatting never changes a value; it only renders a
// Fact's stored value. British English conventions: "c." for circa, thin grouping.

import type { Fact, FactValueKind } from "../engine/types";

// The blank printed where a figure is absent: an en-dash (house style has no em-dashes).
// Compare against this constant, never a literal, so a renderer and a reader cannot drift.
export const BLANK = "\u2013";

export function formatValue(
  value: number | string | null,
  kind: FactValueKind,
  unit: string
): string {
  if (value === null) return BLANK;
  if (typeof value === "string") return value;

  switch (kind) {
    case "currency":
      return formatCurrency(value, unit);
    case "ratio":
      return `${trim2(value)}x`;
    case "percent":
      return `${trim(value)}%`;
    case "count":
      return `${new Intl.NumberFormat("en-GB").format(value)} ${unit}`.trim();
    default:
      return String(value);
  }
}

function formatCurrency(value: number, unit: string): string {
  const symbol = unit === "GBP" ? "£" : unit === "USD" ? "$" : "";
  const abs = Math.abs(value);
  const sign = value < 0 ? "(" : "";
  const close = value < 0 ? ")" : "";
  let body: string;
  // Band on the ROUNDED thousands, so 999,960 is £1m and not £1000k (WP-QA03 N8).
  if (abs >= 1_000_000 || Math.round(abs / 100) >= 10_000) {
    body = `${trim(abs / 1_000_000)}m`;
  } else if (abs >= 1_000) {
    body = `${trim(abs / 1_000)}k`;
  } else {
    body = new Intl.NumberFormat("en-GB").format(abs);
  }
  return `${sign}${symbol}${body}${close}`;
}

// Exact, fully grouped rendering for evidence cards where the precise figure matters.
export function formatExact(value: number | string | null, unit: string): string {
  if (value === null) return "not resolved";
  if (typeof value === "string") return value;
  const symbol = unit === "GBP" ? "£" : unit === "USD" ? "$" : "";
  const grouped = new Intl.NumberFormat("en-GB").format(value);
  if (unit === "GBP" || unit === "USD") return `${symbol}${grouped}`;
  if (unit === "x") return `${grouped}x`;
  if (unit === "%") return `${grouped}%`;
  return `${grouped} ${unit}`.trim();
}

function trim(n: number): string {
  // one decimal place, trailing zero removed
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

function trim2(n: number): string {
  // up to two decimal places, trailing zeros removed (for ratios like 2.08x)
  const r = Math.round(n * 100) / 100;
  if (Number.isInteger(r)) return String(r);
  return r.toFixed(2).replace(/0$/, "");
}

export function displayFor(fact: Fact): string {
  return formatValue(fact.value, fact.kind, fact.unit);
}
