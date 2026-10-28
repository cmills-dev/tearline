// lib/clientspec/concepts.ts
// The shared concept vocabulary for the client-understanding module (Module 1). Both the
// induction engine (which maps a client's example-sheet field labels onto engine concepts)
// and the renderer (which groups a spec's fields into sections) read this one dictionary, so
// there is a single, auditable place where "what the client calls it" binds to "what the
// engine computes". Nothing here guesses: a label that matches no synonym is left UNMAPPED by
// the caller and recorded as an abstention, never bound to an approximate concept.

export type ConceptFormat = "currency" | "ratio" | "percent" | "integer" | "text";

export interface Concept {
  key: string; // the engine metric / fact key, e.g. "ebitda" (must match lib/engine fact metrics)
  canonicalLabel: string; // the engine's own label, e.g. "EBITDA"
  synonyms: string[]; // lower-cased alternative labels seen on real house sheets
  format: ConceptFormat;
  section: string; // the default section a field of this concept renders under
}

// Section titles, in the order a default house skeleton lays them out.
export const DEFAULT_SKELETON = [
  "Header",
  "Financials",
  "Leverage & liquidity",
  "Balance sheet",
] as const;

// The concept dictionary. Keys MUST match the fact metric keys the engine produces
// (turnover, ebitda, netDebt, ...). Synonyms are the labels a client's own sheet might use;
// keep them lower-cased and conservative so a match is a real match, not a lucky substring.
export const CONCEPTS: Concept[] = [
  { key: "sector", canonicalLabel: "Sector", synonyms: ["sector", "industry", "sub-sector"], format: "text", section: "Header" },

  { key: "turnover", canonicalLabel: "Turnover (revenue)", synonyms: ["turnover", "revenue", "sales", "total revenue", "net sales", "net revenue"], format: "currency", section: "Financials" },
  { key: "grossProfit", canonicalLabel: "Gross profit", synonyms: ["gross profit"], format: "currency", section: "Financials" },
  { key: "operatingProfit", canonicalLabel: "Operating profit", synonyms: ["operating profit", "operating income", "ebit"], format: "currency", section: "Financials" },
  { key: "ebitda", canonicalLabel: "EBITDA", synonyms: ["ebitda", "adjusted ebitda", "adj. ebitda", "adj ebitda", "underlying ebitda"], format: "currency", section: "Financials" },

  { key: "netDebt", canonicalLabel: "Net debt", synonyms: ["net debt"], format: "currency", section: "Leverage & liquidity" },
  { key: "borrowings", canonicalLabel: "Total borrowings", synonyms: ["borrowings", "total borrowings", "loans and borrowings", "gross debt", "total debt", "debt"], format: "currency", section: "Leverage & liquidity" },
  { key: "cash", canonicalLabel: "Cash and cash equivalents", synonyms: ["cash", "cash and cash equivalents", "cash at bank", "cash & equivalents"], format: "currency", section: "Leverage & liquidity" },
  { key: "leverage", canonicalLabel: "Net leverage", synonyms: ["leverage", "net leverage", "net debt/ebitda", "net debt / ebitda", "leverage ratio", "gearing"], format: "ratio", section: "Leverage & liquidity" },
  { key: "interestCover", canonicalLabel: "Interest cover", synonyms: ["interest cover", "interest coverage", "ebitda/interest", "cover ratio"], format: "ratio", section: "Leverage & liquidity" },
  { key: "netCurrentAssets", canonicalLabel: "Net current assets", synonyms: ["net current assets", "working capital"], format: "currency", section: "Leverage & liquidity" },

  { key: "netAssets", canonicalLabel: "Net assets", synonyms: ["net assets", "shareholders' funds", "shareholders funds", "net worth"], format: "currency", section: "Balance sheet" },
  { key: "totalAssets", canonicalLabel: "Total assets", synonyms: ["total assets"], format: "currency", section: "Balance sheet" },
  { key: "equity", canonicalLabel: "Equity", synonyms: ["equity", "total equity", "shareholders equity", "shareholders' equity"], format: "currency", section: "Balance sheet" },
];

const BY_KEY = new Map(CONCEPTS.map((c) => [c.key, c]));

// Normalise a label for matching: lower-case, drop scale/currency notes and punctuation,
// collapse whitespace. So "Adjusted EBITDA (£'000)" -> "adjusted ebitda".
export function normaliseLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ") // drop parenthetical notes like (£'000)
    // Scale / currency marks. `m` / `k` are stripped only as a STANDALONE token (\bm\b), never as
    // the trailing letter of an ordinary word - the old `m\b|k\b` turned "platform" into "platfor"
    // and "network" into "networ", corrupting real labels.
    .replace(/[£$€]|'000|000s|\bm\b|\bk\b/g, " ")
    .replace(/[^a-z0-9/&.\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Map a raw field label to a concept, or null if nothing matches confidently. Matching is
// EXACT against the normalised canonical label or a synonym, so a partial or fuzzy label is
// deliberately left unmapped (the caller records it as an abstention) rather than guessed.
export function matchConcept(label: string): Concept | null {
  const norm = normaliseLabel(label);
  if (!norm) return null;
  for (const c of CONCEPTS) {
    if (normaliseLabel(c.canonicalLabel) === norm) return c;
    for (const syn of c.synonyms) {
      if (normaliseLabel(syn) === norm) return c;
    }
  }
  return null;
}

export function conceptForKey(key: string): Concept | undefined {
  return BY_KEY.get(key);
}

// The section a given concept key renders under; falls back to "Other" for an unknown key.
export function sectionForKey(key: string): string {
  return BY_KEY.get(key)?.section ?? "Other";
}
