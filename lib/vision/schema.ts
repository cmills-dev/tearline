// lib/vision/schema.ts
// The fixed output schema for a scanned-accounts read, a small validator for the subset of
// JSON Schema it uses, and the normaliser that turns validated wire output into typed lines.
//
// The same schema object is sent to the model as structured output and used here to check
// the answer, so the two cannot drift. Structured output needs `additionalProperties: false`
// and every property required on every object, and does not support numeric or length
// constraints (claude-api skill). The API also allows at most 16 parameters with union types
// (a nullable type list or anyOf), found by a rejected request on 15 Sep 2026. So the wire
// format has no nullables at all: text that is not printed is "", a page that is not known is
// 0, and enums carry an explicit "none" member. The normaliser turns those into nulls.
// A third rejection ("compiled grammar is too large") came from fourteen separate line objects,
// so `lines` is one array of a single line schema carrying its `key`. The code, not the grammar,
// checks that each key comes back exactly once.
//
// The model never returns a number. It returns the figure as printed, and the value is parsed
// here from that text, so a figure cannot be computed or rescaled by the model.
//
// Bump VISION_SCHEMA_VERSION whenever the schema or the normaliser's rules change. The cache
// key carries it, so old reads are never served against a new schema.

import {
  ABSTAIN,
  BASE_LINE_KEYS,
  FACILITY_TYPES,
  type BaseLineKey,
  type DebtNote,
  type Facility,
  type FacilityType,
  type MaturityBucket,
  type VisionDocumentMeta,
  type VisionLine,
} from "./types";

// v2 (WP-BE04): net_current_liabilities added to the base lines, and the net_assets definition
// tightened so a net liabilities position keeps its printed label.
// v3 (WP-BE23): lease_liabilities replaced by lease_liabilities_total, _current and _non_current.
export const VISION_SCHEMA_VERSION = 3;

type JsonSchema = Record<string, unknown>;

const text = (): JsonSchema => ({ type: "string" });
const page = (): JsonSchema => ({ type: "integer" });
const oneOf = (values: readonly string[]): JsonSchema => ({ type: "string", enum: [...values] });
const obj = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

export const SIGN_VALUES = ["positive", "negative", "none"] as const;
export const WIRE_FACILITY_TYPES = [...FACILITY_TYPES, "none"] as const;
export const BASIS_VALUES = ["consolidated", "company", "none"] as const;

const LINE_SCHEMA = obj({
  key: oneOf(BASE_LINE_KEYS),
  status: oneOf(["found", "abstain"]),
  abstain_reason: text(),
  printed_label: text(),
  figure_text: text(),
  sign: oneOf(SIGN_VALUES),
  scale_caption: text(),
  pdf_page_index: page(),
  printed_page_number: text(),
  statement: text(),
  period_end: text(),
  note_reference: text(),
});

const FACILITY_SCHEMA = obj({
  name_as_printed: text(),
  type: oneOf(WIRE_FACILITY_TYPES),
  lender: text(),
  amount_drawn_text: text(),
  facility_size_text: text(),
  currency: text(),
  maturity: text(),
  rate_or_margin: text(),
  security: text(),
  ranking: text(),
  pdf_page_index: page(),
});

const BUCKET_SCHEMA = obj({
  bucket_as_printed: text(),
  amount_text: text(),
  pdf_page_index: page(),
});

export const VISION_SCHEMA: JsonSchema = obj({
  document: obj({
    company_name_as_printed: text(),
    period_end: text(),
    currency: text(),
    basis: oneOf(BASIS_VALUES),
  }),
  lines: { type: "array", items: LINE_SCHEMA },
  debt_note: obj({
    status: oneOf(["found", "abstain"]),
    abstain_reason: text(),
    scale_caption: text(),
    pdf_page_indexes: { type: "array", items: page() },
    facilities: { type: "array", items: FACILITY_SCHEMA },
    maturity_buckets: { type: "array", items: BUCKET_SCHEMA },
  }),
});

// ---------------------------------------------------------------------------
// Validator for the subset used above: type (one or a list), enum, anyOf, properties,
// required, additionalProperties false, items. Returns a list of errors; empty is valid.
// ---------------------------------------------------------------------------

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function typeMatches(actual: string, wanted: string): boolean {
  return actual === wanted || (wanted === "number" && actual === "integer");
}

export function validateAgainstSchema(value: unknown, schema: JsonSchema, path = "$"): string[] {
  const errors: string[] = [];
  const t = typeOf(value);
  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf as JsonSchema[];
    if (!branches.some((b) => validateAgainstSchema(value, b, path).length === 0)) {
      return [`${path}: matches no anyOf branch`];
    }
  }
  if (schema.type !== undefined) {
    const wanted = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    if (!wanted.some((w) => typeMatches(t, w))) {
      return [`${path}: expected ${wanted.join("|")}, got ${t}`];
    }
  }
  if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).includes(value)) {
    errors.push(`${path}: value not in enum`);
  }
  if (t === "object" && schema.properties) {
    const props = schema.properties as Record<string, JsonSchema>;
    const record = value as Record<string, unknown>;
    for (const key of (schema.required as string[] | undefined) ?? []) {
      if (!(key in record)) errors.push(`${path}.${key}: missing`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!(key in props)) errors.push(`${path}.${key}: not allowed`);
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      if (key in record) errors.push(...validateAgainstSchema(record[key], sub, `${path}.${key}`));
    }
  }
  if (t === "array" && schema.items) {
    (value as unknown[]).forEach((item, i) => {
      errors.push(...validateAgainstSchema(item, schema.items as JsonSchema, `${path}[${i}]`));
    });
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Wire output -> typed result
// ---------------------------------------------------------------------------

export interface WireLine {
  key: BaseLineKey;
  status: "found" | "abstain";
  abstain_reason: string;
  printed_label: string;
  figure_text: string;
  sign: (typeof SIGN_VALUES)[number];
  scale_caption: string;
  pdf_page_index: number;
  printed_page_number: string;
  statement: string;
  period_end: string;
  note_reference: string;
}
export interface WireFacility {
  name_as_printed: string;
  type: (typeof WIRE_FACILITY_TYPES)[number];
  lender: string;
  amount_drawn_text: string;
  facility_size_text: string;
  currency: string;
  maturity: string;
  rate_or_margin: string;
  security: string;
  ranking: string;
  pdf_page_index: number;
}
export interface WireBucket {
  bucket_as_printed: string;
  amount_text: string;
  pdf_page_index: number;
}
export interface VisionWireOutput {
  document: { company_name_as_printed: string; period_end: string; currency: string; basis: (typeof BASIS_VALUES)[number] };
  lines: WireLine[];
  debt_note: {
    status: "found" | "abstain";
    abstain_reason: string;
    scale_caption: string;
    pdf_page_indexes: number[];
    facilities: WireFacility[];
    maturity_buckets: WireBucket[];
  };
}

export type ParseOutcome = { ok: true; value: VisionWireOutput } | { ok: false; errors: string[] };

export function parseVisionOutput(raw: string): ParseOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, errors: ["$: not JSON"] };
  }
  const errors = validateAgainstSchema(parsed, VISION_SCHEMA);
  if (errors.length) return { ok: false, errors };
  const value = parsed as VisionWireOutput;
  // Two answers for one line cannot both be the printed figure, so the whole read is rejected.
  const seen = new Set<string>();
  for (const line of value.lines) {
    if (seen.has(line.key)) errors.push(`$.lines: key ${line.key} returned twice`);
    seen.add(line.key);
  }
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

// "" (not printed) becomes null; everything else is trimmed.
const orNull = (s: string): string | null => (s.trim().length > 0 ? s.trim() : null);

// The number printed in a figure's text, and whether it is printed as negative (brackets or a
// minus sign). Null when the text holds no digits, such as a dash printed for nil.
export function readPrintedFigure(figure: string): { magnitude: number; negative: boolean } | null {
  const m = figure.match(/\d[\d,]*(?:\.\d+)?/);
  if (!m) return null;
  const magnitude = Number(m[0].replace(/,/g, ""));
  if (!Number.isFinite(magnitude)) return null;
  const negative = /\([^)]*\d[^)]*\)/.test(figure) || /[-−–]\s*[£$€]?\s*\d/.test(figure);
  return { magnitude, negative };
}

// The signed value in printed units, parsed from printed text. Null when no figure is printed.
export function parsePrintedValue(figure: string): number | null {
  const p = readPrintedFigure(figure);
  if (!p) return null;
  return p.negative ? -p.magnitude : p.magnitude;
}

function pageOrNull(p: number, pageCount: number): number | null {
  return Number.isInteger(p) && p >= 1 && p <= pageCount ? p : null;
}

// A "found" line must carry page, printed figure, scale, statement and period, and the sign the
// model reports must agree with how the figure is printed. Anything short of that abstains.
function normaliseLine(w: WireLine, pageCount: number): VisionLine {
  if (w.status === "abstain") {
    return { status: "abstain", reason: orNull(w.abstain_reason) ?? ABSTAIN.noReason };
  }
  const missing: string[] = [];
  if (!orNull(w.figure_text)) missing.push("figure_text");
  if (w.sign === "none") missing.push("sign");
  if (!orNull(w.scale_caption)) missing.push("scale_caption");
  if (w.pdf_page_index === 0) missing.push("pdf_page_index");
  if (!orNull(w.statement)) missing.push("statement");
  if (!orNull(w.period_end)) missing.push("period_end");
  if (missing.length) return { status: "abstain", reason: `${ABSTAIN.incomplete}: ${missing.join(",")}` };
  const pdfPageIndex = pageOrNull(w.pdf_page_index, pageCount);
  if (pdfPageIndex === null) return { status: "abstain", reason: ABSTAIN.pageOutOfRange };

  const printed = readPrintedFigure(w.figure_text);
  if (!printed) return { status: "abstain", reason: `${ABSTAIN.incomplete}: figure_text has no digits` };
  if ((printed.negative ? "negative" : "positive") !== w.sign) return { status: "abstain", reason: ABSTAIN.mismatch };

  return {
    status: "found",
    printedLabel: orNull(w.printed_label),
    figureText: w.figure_text.trim(),
    value: printed.negative ? -printed.magnitude : printed.magnitude,
    sign: w.sign,
    scaleCaption: w.scale_caption.trim(),
    pdfPageIndex,
    printedPageNumber: orNull(w.printed_page_number),
    statement: w.statement.trim(),
    periodEnd: w.period_end.trim(),
    noteReference: orNull(w.note_reference),
  };
}

function normaliseDebtNote(w: VisionWireOutput["debt_note"], pageCount: number): DebtNote {
  if (w.status === "abstain") {
    return { status: "abstain", reason: orNull(w.abstain_reason) ?? ABSTAIN.noReason };
  }
  const facilities: Facility[] = w.facilities.map((f) => ({
    nameAsPrinted: orNull(f.name_as_printed),
    type: f.type === "none" ? null : (f.type as FacilityType),
    lender: orNull(f.lender),
    amountDrawnText: orNull(f.amount_drawn_text),
    amountDrawnValue: parsePrintedValue(f.amount_drawn_text),
    facilitySizeText: orNull(f.facility_size_text),
    facilitySizeValue: parsePrintedValue(f.facility_size_text),
    currency: orNull(f.currency),
    maturity: orNull(f.maturity),
    rateOrMargin: orNull(f.rate_or_margin),
    security: orNull(f.security),
    ranking: orNull(f.ranking),
    pdfPageIndex: pageOrNull(f.pdf_page_index, pageCount),
  }));
  const maturityBuckets: MaturityBucket[] = w.maturity_buckets.map((b) => ({
    bucketAsPrinted: orNull(b.bucket_as_printed),
    amountText: orNull(b.amount_text),
    amountValue: parsePrintedValue(b.amount_text),
    pdfPageIndex: pageOrNull(b.pdf_page_index, pageCount),
  }));
  if (facilities.length === 0 && maturityBuckets.length === 0) return { status: "abstain", reason: ABSTAIN.noFacilities };
  return {
    status: "found",
    scaleCaption: orNull(w.scale_caption),
    pdfPageIndexes: w.pdf_page_indexes.filter((p) => pageOrNull(p, pageCount) !== null),
    facilities,
    maturityBuckets,
  };
}

export interface NormalisedRead {
  document: VisionDocumentMeta;
  lines: Record<BaseLineKey, VisionLine>;
  debtNote: DebtNote;
}

export function normaliseVisionOutput(w: VisionWireOutput, pageCount: number): NormalisedRead {
  const byKey = new Map(w.lines.map((l) => [l.key, l]));
  const lines = Object.fromEntries(
    BASE_LINE_KEYS.map((k) => {
      const line = byKey.get(k);
      return [k, line ? normaliseLine(line, pageCount) : { status: "abstain", reason: ABSTAIN.notReturned }];
    })
  ) as Record<BaseLineKey, VisionLine>;
  return {
    document: {
      companyNameAsPrinted: orNull(w.document.company_name_as_printed),
      periodEnd: orNull(w.document.period_end),
      currency: orNull(w.document.currency),
      basis: w.document.basis === "none" ? null : w.document.basis,
    },
    lines,
    debtNote: normaliseDebtNote(w.debt_note, pageCount),
  };
}

// Every line and the debt note abstaining with one reason. Used when no usable read exists.
export function abstainAll(reason: string): NormalisedRead {
  const lines = Object.fromEntries(BASE_LINE_KEYS.map((k) => [k, { status: "abstain", reason }])) as Record<BaseLineKey, VisionLine>;
  return {
    document: { companyNameAsPrinted: null, periodEnd: null, currency: null, basis: null },
    lines,
    debtNote: { status: "abstain", reason },
  };
}
