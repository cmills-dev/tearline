// lib/ocr/config.ts
// OCR provider selection. DEFAULT IS OFF: with OCR_PROVIDER unset or "none", getOcrProvider()
// returns null and the pipeline degrades to today's exact behaviour (abstain on scanned PDFs).
// This makes the OCR layer purely additive and preserves the no-key default. Enabling a
// provider is an explicit, documented opt-in:
//   OCR_PROVIDER=tesseract   pure-JS OCR (no key); requires the optional tesseract.js +
//                            @hyzyla/pdfium packages to be installed.
//   OCR_PROVIDER=<cloud>     key-gated (Textract / Azure / Google) - not built here.
// A test override lets suites inject a mock provider without env or heavy deps.

import type { OcrProvider } from "./types";

let testOverride: OcrProvider | null | undefined;

export function setOcrProviderForTests(p: OcrProvider | null): void {
  testOverride = p;
}

// Returns the configured OCR provider, or null when OCR is off (the default). The tesseract
// provider is loaded lazily and only when selected, so the default build pulls in nothing.
export async function getOcrProvider(): Promise<OcrProvider | null> {
  if (testOverride !== undefined) return testOverride;
  const which = (process.env.OCR_PROVIDER ?? "none").toLowerCase();
  if (which === "none" || which === "") return null;
  if (which === "tesseract") {
    try {
      const mod = await import("./providers/tesseract");
      return mod.createTesseractProvider();
    } catch {
      // Optional deps not installed: stay off rather than crash the pipeline.
      return null;
    }
  }
  return null;
}
