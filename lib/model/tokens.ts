// lib/model/tokens.ts
// Every colour and font the workbook uses, in one place. The values mirror brand/tokens.json
// (WP-BR05), light theme, the same way lib/deck/tokens.ts does: the Next app cannot import a file
// outside product/, so the values are copied here as Excel ARGB and test/modelLive.test.ts fails if
// they drift from brand/tokens.json. buildWorkbook.ts reads no hex and no font name of its own.
//
// Fonts are brand/tokens.json's office faces: Georgia for words, Courier New for figures, never
// Calibri. Both ship with Excel on Windows and macOS and LibreOffice substitutes metric-compatible
// faces for them.

// Which brand colour each workbook colour is. `input` is the brand's input token: blue for a
// figure typed from a filing is the analyst's convention for a hard-coded input, and the brand
// carries it as a token so the workbook reads no colour of its own.
export const MODEL_BRAND_COLOUR = {
  ink: "ink", // body text and header rules
  muted: "ink-soft", // captions, abstentions, "not reported"
  hairline: "rule", // row separators
  headerFill: "paper-2", // header band
  accent: "stamp", // the one emphasis colour (mode line, section titles, the fulcrum rule)
  input: "input", // a figure typed from a filing, blue by modelling convention
} as const;

export const MODEL_TOKENS = {
  colour: {
    ink: "FF3A3936",
    muted: "FF625F57",
    hairline: "FFD9D3C6",
    headerFill: "FFEEEAE0",
    accent: "FF7B2231",
    input: "FF1F3A93",
  },
  font: {
    text: "Georgia",
    figure: "Courier New",
  },
  size: {
    title: 16,
    body: 10,
    caption: 9,
  },
} as const;

export type ModelTokens = typeof MODEL_TOKENS;
