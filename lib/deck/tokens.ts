// lib/deck/tokens.ts
// The deck's brand values. They mirror brand/tokens.json (WP-BR05), light theme, because a
// printed deck is paper. The Next app cannot import a file outside product/, so the values are
// copied here and test/deck.test.ts fails if they drift from brand/tokens.json.
// The deck is set in Georgia and Courier New, the office faces in DESIGN.md v2: a PDF printed from
// any browser then looks the same with or without the web fonts installed.

export const DECK_TOKENS = {
  name: "Tearline",
  notAdvice: "Information from public filings. Not investment advice.",
  oglAttribution: "Contains public sector information licensed under the Open Government Licence v3.0.",
  colour: {
    paper: "#F4F1EA",
    "paper-2": "#EEEAE0",
    "paper-3": "#E6E1D5",
    cover: "#2A2723",
    ink: "#3A3936",
    "ink-soft": "#625F57",
    "ink-faint": "#66625A",
    "on-cover": "#E8E4DB",
    stamp: "#7B2231",
    "stamp-on-cover": "#D98A8C",
    ok: "#3A6346",
    warn: "#80531A",
    rule: "#D9D3C6",
  },
  font: {
    serif: "Georgia, \"Times New Roman\", serif",
    mono: "\"Courier New\", Courier, monospace",
  },
} as const;
