// lib/clientspec/induce.ts
// Module 1 induction: an example tear sheet in, a ClientSpec plus honest abstentions out.
// The engine is deterministic (no network, no LLM). It reads a client's pasted house-sheet
// text, extracts each row's own label, and binds it to an engine concept ONLY when the
// shared dictionary (lib/clientspec/concepts.ts) matches confidently. A label it cannot map
// is recorded in `unmapped` for analyst review, never guessed onto an approximate concept.
// That abstention is the module's honesty rule.

import type { IngestInput, InducedSpec, InduceClientSpec, ClientSpec, ClientSpecField, ClientStyleTokens } from "./types";
import { matchConcept, conceptForKey, normaliseLabel, DEFAULT_SKELETON } from "./concepts";
import { CONTRACT_VERSION } from "../contracts";

// The split point between a row's LABEL and its value column: the first run of 2+ spaces, a tab, a
// currency mark, or a digit that FOLLOWS whitespace (a separate column). A bare `\d` would split at
// a digit anywhere - including the first character - so a label that legitimately starts with a
// digit ("1st Lien Term Loan", "3M Company") was cut to an empty label and silently dropped. A
// digit inside the label (e.g. "H1") no longer breaks it; only a whitespace-preceded figure does.
const VALUE_START = /(\s{2,}|\t|[£$€]|\s\d)/;

// A dd/mm/yyyy date anywhere in the sheet tips the date format to the UK ordering.
const UK_DATE = /\b\d{1,2}\/\d{1,2}\/\d{4}\b/;

// A row carries a figure (so it is field-like) when it contains a digit.
function hasFigure(line: string): boolean {
  return /\d/.test(line);
}

// The client's own label for a row: the leading text before the value column starts.
function extractLabel(line: string): string {
  const m = VALUE_START.exec(line);
  const cut = m ? line.slice(0, m.index) : line;
  return cut.trim();
}

// A figure-free line is a section heading when it either names one of the default skeleton
// slots (case-insensitive) or is a short standalone ALL-CAPS banner (e.g. "BALANCE SHEET").
function isSectionHeading(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  const named = (DEFAULT_SKELETON as readonly string[]).some((s) => s.toLowerCase() === t.toLowerCase());
  const allCaps = /[A-Z]/.test(t) && t === t.toUpperCase() && t.split(/\s+/).length <= 4;
  return named || allCaps;
}

// The reporting currency, read from the first currency mark seen (defaulting to sterling,
// which is the desk's house currency).
function detectCurrency(text: string): string {
  const m = /[£$€]/.exec(text);
  if (!m) return "GBP";
  return m[0] === "$" ? "USD" : m[0] === "€" ? "EUR" : "GBP";
}

export const induceClientSpec: InduceClientSpec = (input, clientId, opts): InducedSpec => {
  const lines = input.text.split(/\r?\n/);

  // RSI Phase 1: the client's learned synonyms resolve BEFORE the static dictionary, so a label
  // this desk taught us last time maps this time. Keyed by normalised label, so the lookup
  // matches the same normalisation the static matcher uses. Purely per-client (in-silo).
  const learned = new Map((opts?.synonyms ?? []).map((s) => [s.labelNorm, s.conceptKey]));

  const fields: ClientSpecField[] = [];
  const seenKeys = new Set<string>(); // first occurrence of a concept wins the field
  const unmapped: string[] = [];
  const skeleton: string[] = [];
  const seenHeadings = new Set<string>();

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const figure = hasFigure(trimmed);

    // A figure-free heading opens a section; it is not a field.
    if (!figure && isSectionHeading(trimmed)) {
      const keyed = trimmed.toLowerCase();
      if (!seenHeadings.has(keyed)) {
        seenHeadings.add(keyed);
        skeleton.push(trimmed);
      }
      continue;
    }

    // Field-like lines need both a label and a figure. Anything else (prose, notes) is left
    // alone rather than forced into the spec. Extract from the TRIMMED line: a raw line with
    // leading indentation (a tab or two spaces under a heading) would otherwise split at index 0
    // to an empty label and be dropped silently, losing a real field with no abstention.
    if (!figure) continue;
    const label = extractLabel(trimmed);
    if (!label) continue;

    // Learned synonym first (what this client taught us), then the static dictionary. A learned
    // key must still resolve to a real concept, so a stale mapping can never invent one.
    const learnedKey = learned.get(normaliseLabel(label));
    const concept = (learnedKey && conceptForKey(learnedKey)) || matchConcept(label);
    if (!concept) {
      // Honest abstention: an unmatched label is surfaced, never bound to a near-miss concept.
      unmapped.push(label);
      continue;
    }
    if (seenKeys.has(concept.key)) continue;
    seenKeys.add(concept.key);
    fields.push({
      key: concept.key,
      label, // the client's own wording, exactly as written (trimmed)
      ontologyConcept: concept.key,
      required: false,
      resolutionFloor: undefined,
      format: concept.format,
    });
  }

  const styleTokens: ClientStyleTokens = {
    voice: "analyst-understated",
    numberStyle: "tabular",
    dateFormat: UK_DATE.test(input.text) ? "DD/MM/YYYY" : "D MMM YYYY",
    currencyDefault: detectCurrency(input.text),
  };

  const spec: ClientSpec = {
    contractVersion: CONTRACT_VERSION,
    clientId,
    version: 1,
    name: input.name ?? "Induced house sheet",
    fields,
    styleTokens,
    skeleton: skeleton.length > 0 ? skeleton : [...DEFAULT_SKELETON],
    inducedFrom: [input.name ?? "example sheet"],
    createdAt: new Date().toISOString(),
  };

  return { spec, unmapped, mappedCount: fields.length };
};
