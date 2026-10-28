// lib/ocr/providers/tesseract.ts
// Pure-JS OCR provider (no key): renders each PDF page to a grayscale image with
// @hyzyla/pdfium (permissive BSD, pure WASM, no node-canvas / Cairo) and OCRs it with
// tesseract.js. Both are OPTIONAL dependencies, imported via variable specifiers so the
// default build and typecheck never require them; getOcrProvider() only reaches here when
// OCR_PROVIDER=tesseract, and returns null if the packages are absent.
//
// Reality check (see docs/extraction-strategy.md): pure-JS OCR is weak exactly where UK
// accounts hurt - dense numeric tables, decimals, parenthesised negatives. It produces a
// CANDIDATE text plane only; the deterministic scale/tripwire abstention in
// extractFinancialsFromText plus the verify gate remain the safety net.

import type { OcrProvider, OcrPage } from "../types";

const RENDER_SCALE = 300 / 72; // ~300 DPI

export function createTesseractProvider(): OcrProvider {
  return {
    name: "tesseract",
    async ocr(pdf: Uint8Array): Promise<OcrPage[]> {
      try {
        // Variable specifiers keep these out of static resolution.
        const pdfiumSpec = "@hyzyla/pdfium";
        const tesseractSpec = "tesseract.js";
        const { PDFiumLibrary } = (await import(pdfiumSpec)) as unknown as {
          PDFiumLibrary: { init(): Promise<PdfiumLib> };
        };
        const tesseract = (await import(tesseractSpec)) as unknown as {
          createWorker(lang: string): Promise<TessWorker>;
        };

        const lib = await PDFiumLibrary.init();
        const doc = await lib.loadDocument(pdf);
        const worker = await tesseract.createWorker("eng");
        const out: OcrPage[] = [];
        try {
          const n = doc.getPageCount();
          for (let i = 0; i < n; i++) {
            const page = doc.getPage(i);
            const image = await page.render({ scale: RENDER_SCALE, render: "bitmap" });
            const { data } = await worker.recognize(image.data as Uint8Array);
            out.push({ page: i + 1, text: data.text ?? "", confidence: (data.confidence ?? 0) / 100 });
          }
        } finally {
          await worker.terminate();
          doc.destroy();
          lib.destroy();
        }
        return out;
      } catch {
        return [];
      }
    },
  };
}

// Minimal structural types for the optional deps (avoid `any`).
interface PdfiumLib {
  loadDocument(bytes: Uint8Array): Promise<PdfiumDoc>;
  destroy(): void;
}
interface PdfiumDoc {
  getPageCount(): number;
  getPage(i: number): PdfiumPage;
  destroy(): void;
}
interface PdfiumPage {
  render(opts: { scale: number; render: string }): Promise<{ data: unknown }>;
}
interface TessWorker {
  recognize(img: unknown): Promise<{ data: { text?: string; confidence?: number } }>;
  terminate(): Promise<void>;
}
