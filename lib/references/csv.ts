// lib/references/csv.ts
// CSV cells that a spreadsheet cannot execute. A figure's printed text, a document name or a
// locator is text from a filing or the register, so it is untrusted: a cell that opens with
// "=", "+", "-", "@", a tab or a carriage return is read by Excel, LibreOffice and Google Sheets
// as a formula (CSV injection, OWASP). Such a cell is prefixed with a single quote, which every
// one of them shows as text and does not evaluate.
//
// A plain number is left alone, so a negative value such as "-1400000" stays a number a
// spreadsheet can add up. "Plain" is strict: digits, one optional leading sign, an optional
// decimal part and an optional exponent, and nothing else, so "-1+1" or "-2e3*A1" is still
// neutralised.

const PLAIN_NUMBER = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/;
// Leading whitespace does not stop a spreadsheet reading a formula, so it is looked through.
const FORMULA_START = /^[\s ]*[=+\-@\t\r]/;

export function neutraliseCell(value: string): string {
  if (PLAIN_NUMBER.test(value)) return value;
  return FORMULA_START.test(value) ? `'${value}` : value;
}

// RFC 4180 quoting on top of the guard: a field with a comma, a quote or a line break is quoted
// and any quote inside it is doubled.
export function csvCell(value: string | number | null | undefined): string {
  const s = neutraliseCell(value == null ? "" : String(value));
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Rows are CRLF-terminated so spreadsheets read them cleanly. The byte order mark makes Excel
// read the file as UTF-8, without which "£m" arrives as "Â£m".
export function toCsvText(header: readonly string[], rows: readonly (readonly (string | number | null)[])[], bom = true): string {
  const lines = [header.map(csvCell).join(",")];
  for (const r of rows) lines.push(r.map(csvCell).join(","));
  return (bom ? "﻿" : "") + lines.join("\r\n") + "\r\n";
}
