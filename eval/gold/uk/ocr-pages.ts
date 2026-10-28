// eval/gold/uk/ocr-pages.ts (WP-OCR2)
// OCR, once, every page the recorded first reads of the UK gold scans cite, and store each page's
// layer under eval/gold/uk/ocr/<transactionId>/p<N>.json. eval/gold/uk-ocr-verify.ts and the tests
// then read the stored layers and never OCR anything.
//
// One page at a time, one process at a time (lib/ocr/pageLayer.ts). A page already stored is not
// OCR'd again. Each page OCR'd appends its wall time and peak memory to
// eval/gold/uk/ocr/measurements.json. The run stops at the first page that peaks above 2 GB.
//
// Build the binary first, from product/:
//   swiftc -O scripts/ocr/pageocr.swift -o scripts/ocr/.build/pageocr
// Run: ./node_modules/.bin/tsx eval/gold/uk/ocr-pages.ts

import { existsSync, readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { diskPageSource, type OcrMeasurement } from "../../../lib/ocr/pageLayer";
import { BASE_LINE_KEYS, type FoundLine } from "../../../lib/vision/types";
import { UK_GOLD } from "../uk";
import { replayFirstRead } from "../ukReplay";

const here = dirname(fileURLToPath(import.meta.url));
export const OCR_DIR = join(here, "ocr");
const BIN = join(here, "..", "..", "..", "scripts", "ocr", ".build", "pageocr");
const MEASURED = join(OCR_DIR, "measurements.json");
const LIMIT_BYTES = 2 * 1024 * 1024 * 1024;

async function main() {
  if (!existsSync(BIN)) throw new Error(`build ${BIN} first (see the header)`);
  const measurements: (OcrMeasurement & { folder: string })[] = existsSync(MEASURED) ? JSON.parse(readFileSync(MEASURED, "utf8")) : [];
  let folder = "";
  let over: OcrMeasurement | null = null;
  const source = diskPageSource({
    dir: OCR_DIR,
    bin: BIN,
    onMeasured: (m) => {
      measurements.push({ folder, ...m });
      writeFileSync(MEASURED, JSON.stringify(measurements, null, 1) + "\n");
      const mb = m.peakBytes === null ? "?" : (m.peakBytes / 1e6).toFixed(0);
      console.log(`  p${m.page}: ${m.seconds.toFixed(1)} s, peak ${mb} MB`);
      if (m.peakBytes !== null && m.peakBytes > LIMIT_BYTES) over = m;
    },
  });
  for (const g of UK_GOLD.filter((c) => c.scan)) {
    const r = await replayFirstRead(g);
    if (!r) continue;
    folder = g.folder;
    const pages = [...new Set(BASE_LINE_KEYS.map((k) => r.read.lines[k]).filter((l): l is FoundLine => l.status === "found").map((l) => l.pdfPageIndex))].sort((a, b) => a - b);
    console.log(`${g.folder}: pages ${pages.join(", ")}`);
    for (const p of pages) {
      const got = await source.page(r.pdfBytes, g.transactionId, p);
      if (!got.ok) console.log(`  p${p}: ${got.reason}`);
      if (over) {
        console.log(`STOPPED: page ${(over as OcrMeasurement).page} peaked above 2 GB.`);
        process.exit(2);
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
