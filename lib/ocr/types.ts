// lib/ocr/types.ts
// OCR provider interface for the scanned-PDF (Layer 3) fallback. OCR text is a GROUNDING
// SUBSTRATE, never a trust anchor: its output is fed into the SAME deterministic
// extractFinancialsFromText (scale detection, labelled-line reading, the operating-profit
// tripwire, abstain-on-doubt), so every anti-fabrication guard still applies. A provider
// returns per-page text with a confidence; an empty/low-confidence result simply abstains.

export interface OcrPage {
  page: number; // 1-indexed
  text: string;
  confidence?: number; // 0..1, when the engine reports one
}

export interface OcrProvider {
  name: string;
  // OCR a PDF's bytes into per-page text. Never throws; returns [] on failure.
  ocr(pdf: Uint8Array): Promise<OcrPage[]>;
}
