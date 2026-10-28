// lib/llm/extract.ts
// The parsing engine's public surface: turn free-text document content into strict,
// source-anchored extractions using whichever LLMProvider is configured.
//
// DOCTRINE (non-negotiable): a model may only surface a number that is anchored to
// text actually present in the source document. After the model responds, every
// extraction whose `sourceQuote` cannot be found verbatim inside `documentText`
// (case-insensitive, whitespace-normalised) is DROPPED. This is what stops the model
// fabricating figures: every surviving number points at real source text, exactly the
// invariant the engine's Fact/provenance model depends on (see lib/engine/types.ts).

import type { LLMProvider } from "./types";
import type { ProvenanceTag } from "../engine/types";

// One structured figure the model claims to have found. `sourceQuote` must be a
// verbatim slice of the document; that claim is enforced, not trusted.
export interface Extraction {
  metric: string;
  valueText: string;
  unit?: string;
  sourceQuote: string;
  note?: string;
}

// Options for extraction. `provider` may be null (engine disabled) -> returns [].
export interface ExtractOptions {
  metrics: string[];
  provider?: LLMProvider | null;
  maxTokens?: number;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  "You are a precise financial-document parser.",
  "You extract figures ONLY when they appear in the supplied document.",
  "You never estimate, infer, or invent numbers.",
  "For every metric you can locate, you copy a VERBATIM quote from the document that",
  "contains the figure. If a metric is absent, you omit it entirely.",
  "You reply with STRICT JSON only, no prose and no code fences.",
].join(" ");

function buildUserPrompt(documentText: string, metrics: string[]): string {
  return [
    "Extract the following metrics from the document below.",
    "",
    "Metrics to look for (use these exact keys):",
    ...metrics.map((m) => `  - ${m}`),
    "",
    "Return STRICT JSON of the form:",
    '{ "extractions": [',
    '  { "metric": "<one of the keys above>",',
    '    "valueText": "<the figure exactly as written, e.g. \\"1,234.5\\">",',
    '    "unit": "<optional, e.g. GBP, %, x, FTE>",',
    '    "sourceQuote": "<a VERBATIM span copied from the document containing the figure>",',
    '    "note": "<optional short clarification>" }',
    "] }",
    "",
    "Rules:",
    "- Only include a metric if it genuinely appears in the document.",
    "- sourceQuote MUST be copied character-for-character from the document.",
    "- Do not wrap the JSON in markdown code fences.",
    "",
    "DOCUMENT:",
    documentText,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Robust JSON parsing
// ---------------------------------------------------------------------------

// Strip a leading/trailing markdown code fence (```json ... ``` or ``` ... ```),
// tolerating a language tag and surrounding whitespace.
export function stripCodeFences(raw: string): string {
  let s = raw.trim();
  if (s.startsWith("```")) {
    // Drop the opening fence line (``` optionally followed by a language tag).
    s = s.replace(/^```[^\n]*\n?/, "");
    // Drop the closing fence.
    s = s.replace(/\n?```\s*$/, "");
  }
  return s.trim();
}

// Parse the model output into a raw list of candidate extractions. Tolerant of the
// model returning either a bare array or an object with an `extractions` array, and
// of stray text around the JSON (we fall back to the first {...} / [...] block).
// Exported so tests can drive the exact parse path extractFactsFromDocument uses,
// synchronously (the completion round-trip is the only async part).
export function parseExtractions(raw: string): Extraction[] {
  const cleaned = stripCodeFences(raw);

  const tryParse = (text: string): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };

  let parsed = tryParse(cleaned);

  if (parsed === undefined) {
    // Last resort: grab the first JSON object or array embedded in the text.
    const match = cleaned.match(/[{[][\s\S]*[}\]]/);
    if (match) parsed = tryParse(match[0]);
  }

  if (parsed === undefined || parsed === null) return [];

  const list: unknown = Array.isArray(parsed)
    ? parsed
    : (parsed as { extractions?: unknown }).extractions;

  if (!Array.isArray(list)) return [];

  const out: Extraction[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const metric = typeof rec.metric === "string" ? rec.metric : undefined;
    const valueText =
      typeof rec.valueText === "string"
        ? rec.valueText
        : typeof rec.value === "string"
          ? rec.value
          : typeof rec.value === "number"
            ? String(rec.value)
            : undefined;
    const sourceQuote = typeof rec.sourceQuote === "string" ? rec.sourceQuote : undefined;
    if (!metric || valueText === undefined || !sourceQuote) continue;
    out.push({
      metric,
      valueText,
      sourceQuote,
      unit: typeof rec.unit === "string" ? rec.unit : undefined,
      note: typeof rec.note === "string" ? rec.note : undefined,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Doctrine guard
// ---------------------------------------------------------------------------

// Normalise whitespace and case so the substring test is robust to reflowed text
// (line breaks, doubled spaces) without loosening it into a fuzzy match.
function normalise(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

// True when `quote` appears within `documentText` after whitespace/case normalisation.
export function quoteIsAnchored(quote: string, documentText: string): boolean {
  const q = normalise(quote);
  if (q.length === 0) return false;
  return normalise(documentText).includes(q);
}

// The digit run of a value/quote, separators stripped ("£420,000" -> "420000",
// "5.9x" -> "59"), so a value is matched by its significant digits regardless of
// currency, scale suffix or thousands separators.
function digitsOnly(s: string): string {
  return s.replace(/[^0-9]/g, "");
}

// True when the value's own digits appear INSIDE the quoted span. This closes the
// "right quote, wrong number" hole the research flags: a model may copy a genuine
// verbatim sentence yet report a figure that is not in it. A value whose digits are not
// present in its own quote is not grounded, so it is dropped. (Page/offset matching is
// added in the PDF path, where each quote carries a page anchor; here the document is a
// flat string, so the in-span digit check is the applicable gate.)
export function valueGroundedInQuote(valueText: string, quote: string): boolean {
  const v = digitsOnly(valueText);
  if (v.length === 0) return false; // a figure with no digits cannot be grounded
  // The value's digit sequence must equal a WHOLE number token in the quote, not merely be a
  // substring of the quote's concatenated digits. The old substring test let digits straddling
  // two separate numbers ground a fabricated figure (e.g. value "7.2" grounded by "grew 7% to
  // 2.4m", whose digits "724" contain "72"), and let a scale error survive (value "420" against
  // "420,000"). Tokenise the quote into number runs and compare digit-strings exactly.
  const tokens = quote.match(/[0-9][0-9.,]*[0-9]|[0-9]/g) ?? [];
  return tokens.some((t) => sameFigure(valueText, t));
}

// Two printed figures are the same figure when their digits match AND the decimal point sits in
// the same place. Digits alone let "5.0" ground "£50m" and "1.2" ground "12 facilities", a 10x
// error each (WP-QA03 N10). A comma is a thousands separator here, as everywhere on this path.
function sameFigure(valueText: string, token: string): boolean {
  if (digitsOnly(valueText) !== digitsOnly(token)) return false;
  const a = Number(valueText.replace(/[^0-9.]/g, ""));
  const b = Number(token.replace(/[^0-9.]/g, ""));
  return Number.isFinite(a) && Number.isFinite(b) && a === b;
}

// --- Sign grounding: a value's sign must match how its token is presented in the quote, so a loss
// reported as a positive profit (or vice versa) is dropped. ---
function valueIsNegative(valueText: string): boolean {
  const t = valueText.trim();
  return t.startsWith("-") || /^\(.*\)$/.test(t);
}
// True when the value's matching token is presented as NEGATIVE in the quote: wrapped in
// parentheses, immediately preceded by a minus, or a loss/deficit word sits just before it.
function quoteTokenNegative(valueText: string, quote: string): boolean {
  const v = digitsOnly(valueText);
  const re = /[0-9][0-9.,]*[0-9]|[0-9]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(quote)) !== null) {
    if (digitsOnly(m[0]) !== v || !sameFigure(valueText, m[0])) continue;
    const start = m.index;
    const end = start + m[0].length;
    const parenWrapped = /\(\s*$/.test(quote.slice(Math.max(0, start - 3), start)) && /^\s*\)/.test(quote.slice(end, end + 3));
    const minusBefore = /-\s*$/.test(quote.slice(Math.max(0, start - 2), start));
    const lossWord = /\b(loss|deficit|negative)\b/i.test(quote.slice(Math.max(0, start - 25), start));
    if (parenWrapped || minusBefore || lossWord) return true;
  }
  return false;
}
export function signGrounded(valueText: string, quote: string): boolean {
  return valueIsNegative(valueText) === quoteTokenNegative(valueText, quote);
}

// --- Scale grounding: if the claimed unit asserts a scale multiplier (thousands/millions/billions),
// a matching marker must appear in the quote or the wider document. This closes the classic 1000x
// error where the model fabricates "GBPm" against a document that only says "£5.0". ---
function claimedScale(unit: string | undefined): "bn" | "m" | "k" | null {
  if (!unit) return null;
  const u = unit.toLowerCase().replace(/[^a-z0-9']/g, "");
  if (/(bn|billion)/.test(u)) return "bn";
  if (/million$|mn$|m$/.test(u)) return "m";
  if (/thousand$|k$|'?000$/.test(u)) return "k";
  return null;
}
function textHasScale(text: string, scale: "bn" | "m" | "k"): boolean {
  const q = text.toLowerCase();
  if (scale === "bn") return /\d\s*bn\b/.test(q) || /billion/.test(q);
  if (scale === "m") return /\d\s*mn?\b/.test(q) || /million/.test(q);
  return /\d\s*k\b/.test(q) || /thousand/.test(q) || /'000/.test(q) || /£\s*'?0{3}/.test(q);
}
export function scaleGrounded(unit: string | undefined, quote: string, documentText: string): boolean {
  const scale = claimedScale(unit);
  if (!scale) return true; // no scale asserted -> nothing to ground
  return textHasScale(quote, scale) || textHasScale(documentText, scale);
}

// Drop any extraction that is not (a) anchored verbatim in the document, (b) whose value digits sit
// inside its own quote, (c) whose SIGN matches how the quote presents that token, and (d) whose
// claimed scale multiplier (if any) is supported by the quote or document. Exported so tests and
// callers can exercise the guard in isolation. Nothing that fails any check reaches the caller.
export function applyDoctrineGuard(
  extractions: Extraction[],
  documentText: string
): Extraction[] {
  return extractions.filter(
    (e) =>
      quoteIsAnchored(e.sourceQuote, documentText) &&
      valueGroundedInQuote(e.valueText, e.sourceQuote) &&
      signGrounded(e.valueText, e.sourceQuote) &&
      scaleGrounded(e.unit, e.sourceQuote, documentText),
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function extractFactsFromDocument(
  documentText: string,
  opts: ExtractOptions
): Promise<Extraction[]> {
  const provider = opts.provider;
  // Engine disabled/unset: degrade to no extractions rather than throwing.
  if (!provider) return [];
  if (!documentText || opts.metrics.length === 0) return [];

  const raw = await provider.complete({
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(documentText, opts.metrics),
    maxTokens: opts.maxTokens,
  });

  const candidates = parseExtractions(raw);
  // The guard is applied unconditionally: nothing reaches the caller unanchored.
  return applyDoctrineGuard(candidates, documentText);
}

// ---------------------------------------------------------------------------
// Bridge toward the engine's Fact / provenance shape
// ---------------------------------------------------------------------------
// We do NOT assemble the final Fact here (rung resolution, ids, hashing and
// verification belong to the engine pipeline). Instead we hand the caller a clean,
// typed draft carrying everything the LLM legitimately produced: the metric, the raw
// value text (still text, so the caller controls numeric parsing), the unit, and a
// provenance snippet that is guaranteed to be the anchored source quote. The caller
// wraps this as an R1 Fact with a real sourceId, locator, hash and retrievedAt.

export interface ExtractedProvenanceDraft {
  tag: ProvenanceTag; // defaults to "Web" for parsed documents; caller may override
  snippet: string; // the verbatim, doctrine-verified source quote
}

export interface ExtractedFactDraft {
  metric: string;
  valueText: string; // unparsed; caller decides how to coerce to number
  unit?: string;
  note?: string;
  provenance: ExtractedProvenanceDraft;
}

// Map surviving extractions to Fact drafts. `tag` lets the caller stamp the correct
// provenance class (e.g. "Acc" for filed accounts) for the document being parsed.
export function toFactDrafts(
  extractions: Extraction[],
  tag: ProvenanceTag = "Web"
): ExtractedFactDraft[] {
  return extractions.map((e) => ({
    metric: e.metric,
    valueText: e.valueText,
    unit: e.unit,
    note: e.note,
    provenance: { tag, snippet: e.sourceQuote },
  }));
}
