// lib/vision/ocrVerify.ts
// The verifier that makes the second read on local OCR (WP-OCR2). It gets the OCR layer of every
// page the first read cited, one page at a time, turns them into a second read
// (lib/vision/ocrSecondRead.ts), and judges it with judgeDoubleRead, the same judgement the model
// second read gets. It makes no model call and reports no usage.
//
// It keeps the verifier contract in ./types.ts: it confirms or abstains, never rewrites a line and
// never supplies one, and the same read and the same layers give the same result.

import { diskPageSource, type OcrPageLayer, type OcrPageSource } from "../ocr/pageLayer";
import { OCR_VERIFIER_NAME, ocrSecondRead, type OcrLineDiagnostic } from "./ocrSecondRead";
import { BASE_LINE_KEYS, type FoundLine, type VerifiedLine, type VisionVerifier, type VisionVerifyInput, type VisionVerifyResult } from "./types";
import { judgeDoubleRead } from "./verify";

export interface OcrVerifierDeps {
  // Where page layers come from. Default: the disk cache in OCR_PAGE_CACHE_DIR (or
  // .cache/ocr-pages), OCR'ing a missing page only when OCR_PAGEOCR_BIN names the binary.
  pages?: OcrPageSource;
}

export function defaultOcrPageSource(): OcrPageSource {
  return diskPageSource({
    dir: process.env.OCR_PAGE_CACHE_DIR || ".cache/ocr-pages",
    bin: process.env.OCR_PAGEOCR_BIN || null,
  });
}

export interface OcrVerifyResult extends VisionVerifyResult {
  diagnostics: OcrLineDiagnostic[];
}

export class OcrSecondReadVerifier implements VisionVerifier {
  readonly name = OCR_VERIFIER_NAME;
  constructor(private readonly deps: OcrVerifierDeps = {}) {}

  async verify(input: VisionVerifyInput): Promise<OcrVerifyResult> {
    const { read, pdfBytes } = input;
    const found = BASE_LINE_KEYS.filter((k) => read.lines[k].status === "found");
    if (found.length === 0) {
      const lines = Object.fromEntries(
        BASE_LINE_KEYS.map((k) => [k, { tag: "not-checked", note: "The reader abstained on this line, so there was nothing to check." } as VerifiedLine])
      ) as VisionVerifyResult["lines"];
      return { verifier: this.name, lines, overrides: {}, usage: null, diagnostics: [] };
    }
    const source = this.deps.pages ?? defaultOcrPageSource();
    const pages = [...new Set(found.map((k) => (read.lines[k] as FoundLine).pdfPageIndex))].sort((a, b) => a - b);
    const layers = new Map<number, OcrPageLayer | string>();
    // One page at a time, in order: never two OCR processes (lib/ocr/pageLayer.ts).
    for (const p of pages) {
      const got = await source.page(pdfBytes, read.transactionId, p);
      layers.set(p, got.ok ? got.layer : got.reason);
    }
    const second = ocrSecondRead(read, layers);
    const judged = judgeDoubleRead(read, second.wire, second.pages, this.name, { accountsType: input.accountsType ?? null });
    return { verifier: this.name, lines: judged.lines, overrides: judged.overrides, usage: null, diagnostics: second.diagnostics };
  }
}
