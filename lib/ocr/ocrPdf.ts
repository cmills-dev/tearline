// lib/ocr/ocrPdf.ts
// Run an OCR provider over a scanned PDF and return its text, or null when OCR yields
// nothing usable. Low-confidence pages are dropped; the joined text is only a candidate
// substrate for the deterministic extractor, which still applies every guard.

import type { OcrProvider } from "./types";

const MIN_PAGE_CONFIDENCE = 0.5;

export async function ocrPdf(pdf: Uint8Array, provider: OcrProvider): Promise<string | null> {
  let pages;
  try {
    pages = await provider.ocr(pdf);
  } catch {
    return null;
  }
  const usable = pages.filter((p) => (p.confidence ?? 1) >= MIN_PAGE_CONFIDENCE && p.text.trim().length > 0);
  if (usable.length === 0) return null;
  const text = usable.map((p) => p.text).join("\n");
  return text.trim().length >= 40 ? text : null;
}
