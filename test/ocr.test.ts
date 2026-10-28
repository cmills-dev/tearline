// test/ocr.test.ts
// The OCR Layer-3 fallback. Default OFF (no provider). With a mock provider, OCR text flows
// through the SAME deterministic extractor + guards: figures are read only when the scale is
// declared, and the source line is kept as the grounding snippet - no fabrication path.

import { suite, test, assert, assertEqual } from "./harness";
import { getOcrProvider, setOcrProviderForTests } from "../lib/ocr/config";
import { ocrPdf } from "../lib/ocr/ocrPdf";
import { extractFinancialsFromText } from "../lib/sources/pdfAccounts";
import type { OcrProvider } from "../lib/ocr/types";

const ACCOUNTS_TEXT = [
  "NORTHWIND TRADING LIMITED",
  "Figures in £'000                     2024      2023",
  "Turnover                           152,300   148,100",
  "Operating profit                    24,900    22,100",
  "Cash and cash equivalents           12,500     9,800",
].join("\n");

const mockProvider = (text: string, confidence = 0.9): OcrProvider => ({
  name: "mock",
  async ocr() {
    return [{ page: 1, text, confidence }];
  },
});

suite("ocr / config default off");

export async function registerOcrTests(): Promise<void> {
  setOcrProviderForTests(undefined as unknown as null); // clear override -> read env
  const defaultProvider = await getOcrProvider();

  setOcrProviderForTests(mockProvider(ACCOUNTS_TEXT));
  const provider = (await getOcrProvider())!;
  const ocrText = await ocrPdf(new Uint8Array([1, 2, 3]), provider);
  const ex = ocrText ? extractFinancialsFromText(ocrText, "ocr") : null;

  setOcrProviderForTests(mockProvider("scanned page with no numbers", 0.2));
  const lowConf = await ocrPdf(new Uint8Array([1]), (await getOcrProvider())!);

  setOcrProviderForTests(null); // reset

  suite("ocr / fallback");

  test("OCR is off by default (no provider, no key) - pipeline abstains on scans", () => {
    assertEqual(defaultProvider, null, "no provider unless configured");
  });

  test("OCR text runs through the deterministic extractor with an 'ocr' provenance tag", () => {
    assert(!!ex, "extracted from OCR text");
    assertEqual(ex!.lines.find((l) => l.metric === "turnover")?.value, 152_300_000, "turnover read + scaled");
    assert(ex!.lines.every((l) => l.concept.startsWith("ocr:")), "lines tagged ocr:");
  });

  test("low-confidence OCR pages are dropped (abstain, never a guess)", () => {
    assertEqual(lowConf, null, "low confidence -> null");
  });
}
