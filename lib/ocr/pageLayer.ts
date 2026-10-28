// lib/ocr/pageLayer.ts
// The OCR layer of one page, with word boxes, cached on disk per page (WP-OCR2).
//
// The layer is what scripts/ocr/pageocr.swift prints: every text observation Apple Vision found
// on the page, with its box as fractions of the page, origin top left. The second read on OCR
// (lib/vision/ocrSecondRead.ts) reads rows and columns out of it.
//
// MEMORY RULE. On 21 Sep 2026 parallel runs of a local OCR tool reached 114 GB and the Mac
// killed everything. So:
//   - pageocr OCRs exactly one page per process, and takes /tmp/pdfocr.lock, so a second OCR
//     process anywhere on the Mac waits for the first to exit;
//   - this module runs it with spawnSync, one page at a time, and never from two calls at once in
//     one process (the `busy` flag below refuses a re-entrant call rather than queueing it);
//   - every page is cached on disk as JSON, so a page is OCR'd once, ever.
// One page peaked at 397 MB (WP-OCR2, 24 Sep 2026; the report has every page).
//
// Off unless asked: OCR runs only when a binary path is given (OCR_PAGEOCR_BIN) and the host is
// macOS. Otherwise only pages already on disk are read, and a missing page is a missing layer,
// which makes its lines abstain.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface OcrObservation {
  text: string;
  confidence: number; // 0..1, Vision's own
  box: [number, number, number, number]; // x0, y0, x1, y1 as fractions of the page, origin top left
}

export interface OcrPageLayer {
  engine: string; // e.g. "apple-vision/accurate/no-lc/6x"
  page: number; // 1-based PDF page index
  width: number; // points
  height: number;
  observations: OcrObservation[];
}

export type OcrPageResult = { ok: true; layer: OcrPageLayer; fromCache: boolean } | { ok: false; reason: string };

export interface OcrPageSource {
  readonly name: string;
  // The layer of one page of one filing. Never throws.
  page(pdfBytes: Uint8Array, transactionId: string, pdfPageIndex: number): Promise<OcrPageResult>;
}

export function isPageLayer(v: unknown): v is OcrPageLayer {
  const l = v as OcrPageLayer;
  return (
    !!l &&
    typeof l.engine === "string" &&
    Number.isInteger(l.page) &&
    Array.isArray(l.observations) &&
    l.observations.every(
      (o) => o && typeof o.text === "string" && Array.isArray(o.box) && o.box.length === 4 && o.box.every((n) => typeof n === "number")
    )
  );
}

// Pages already OCR'd, held in memory. Tests and fixtures use this.
export function memoryPageSource(pages: Record<string, OcrPageLayer>, name = "memory"): OcrPageSource {
  return {
    name,
    async page(_bytes, transactionId, pdfPageIndex) {
      const layer = pages[`${transactionId}:${pdfPageIndex}`];
      return layer ? { ok: true, layer, fromCache: true } : { ok: false, reason: `no OCR layer is held for page ${pdfPageIndex}` };
    },
  };
}

export interface DiskPageSourceOptions {
  dir: string; // <dir>/<transactionId>/p<N>.json
  bin?: string | null; // the pageocr binary; null or absent means read the cache only
  timeoutMs?: number;
  // Called after each page actually OCR'd, with what /usr/bin/time measured.
  onMeasured?: (m: OcrMeasurement) => void;
}

export interface OcrMeasurement {
  transactionId: string;
  page: number;
  seconds: number; // wall clock
  peakBytes: number | null; // peak memory footprint, from /usr/bin/time -l
  maxRssBytes: number | null;
}

export function pageCachePath(dir: string, transactionId: string, pdfPageIndex: number): string {
  return join(dir, transactionId.replace(/[^A-Za-z0-9_-]/g, "_"), `p${pdfPageIndex}.json`);
}

let busy = false;

export function diskPageSource(opts: DiskPageSourceOptions): OcrPageSource {
  return {
    name: opts.bin ? "apple-vision-disk" : "apple-vision-disk-cache-only",
    async page(pdfBytes, transactionId, pdfPageIndex) {
      const path = pageCachePath(opts.dir, transactionId, pdfPageIndex);
      if (existsSync(path)) {
        try {
          const layer = JSON.parse(readFileSync(path, "utf8"));
          if (isPageLayer(layer)) return { ok: true, layer, fromCache: true };
        } catch {
          // fall through: a corrupt cache file is treated as missing
        }
      }
      if (!opts.bin) return { ok: false, reason: `no OCR layer is stored for page ${pdfPageIndex}, and this run may not OCR` };
      if (process.platform !== "darwin") return { ok: false, reason: "local OCR runs only on macOS" };
      if (busy) return { ok: false, reason: "another page is being OCR'd; pages are OCR'd one at a time" };
      busy = true;
      const pdfPath = join(tmpdir(), `pageocr-${process.pid}-${transactionId.replace(/[^A-Za-z0-9_-]/g, "_")}.pdf`);
      try {
        writeFileSync(pdfPath, pdfBytes);
        const started = Date.now();
        const run = spawnSync("/usr/bin/time", ["-l", opts.bin, pdfPath, String(pdfPageIndex)], {
          encoding: "utf8",
          timeout: opts.timeoutMs ?? 180_000,
          maxBuffer: 64 * 1024 * 1024,
        });
        const seconds = (Date.now() - started) / 1000;
        if (run.status !== 0) return { ok: false, reason: `the OCR of page ${pdfPageIndex} failed (exit ${run.status ?? run.signal})` };
        const layer = JSON.parse(run.stdout);
        if (!isPageLayer(layer)) return { ok: false, reason: `the OCR of page ${pdfPageIndex} came back in a shape that could not be read` };
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, JSON.stringify(layer) + "\n");
        opts.onMeasured?.({ transactionId, page: pdfPageIndex, seconds, ...timeMeasures(run.stderr) });
        return { ok: true, layer, fromCache: false };
      } catch {
        return { ok: false, reason: `the OCR of page ${pdfPageIndex} failed` };
      } finally {
        busy = false;
        try {
          unlinkSync(pdfPath);
        } catch {
          // already gone
        }
      }
    },
  };
}

// Peak memory footprint and max RSS from the stderr of macOS /usr/bin/time -l.
export function timeMeasures(stderr: string): { peakBytes: number | null; maxRssBytes: number | null } {
  const grab = (label: string) => {
    const m = stderr.match(new RegExp(`(\\d+)\\s+${label}`));
    return m ? Number(m[1]) : null;
  };
  return { peakBytes: grab("peak memory footprint"), maxRssBytes: grab("maximum resident set size") };
}
