// lib/vision/hybridVerify.ts
// The hybrid second read (WP-OCR3, RS-02 rank 2). Local OCR reads every found line first, and costs
// nothing. The model second read is paid for only on the lines OCR abstained on. Selected by
// VISION_SECOND_READ=hybrid (lib/vision/verify.ts createVisionVerifier).
//
// The decision for each found line, in order:
//   1. OCR confirms it: the line is confirmed on OCR's evidence and no model call is made for it.
//   2. OCR placed a figure on the line that differs from the first read (value, sign, or a scale
//      both captions establish): the line abstains with HYBRID_ABSTAIN.disagree. The first read
//      is a model read, so OCR and the model disagree, and no model second read could make the
//      line land (a confirmation would still be a disagreement), so none is paid for.
//   3. OCR abstained for any other reason (no layer, label or column not found, no unit caption,
//      a failed tie, basis): the line goes to the model second read, which confirms or abstains.
//      If OCR had read the same digits, the model's note says so.
//   4. The model second read could not run, or threw: the lines sent to it abstain with its
//      reason (or HYBRID_ABSTAIN.modelFailed). Lines OCR confirmed still stand.
//
// It keeps the verifier contract in ./types.ts: every line is tagged, a line is only ever
// confirmed on a channel's own evidence (doubleReadProblem still checks it at landing), a
// disagreement abstains, and the model is asked only about the lines it is sent, so it cannot
// confirm or reject a line OCR decided.

import type { LLMUsage } from "../llm/types";
import { scaleFromCaption, toPence } from "./scale";
import { readPrintedFigure } from "./schema";
import type { OcrLineDiagnostic } from "./ocrSecondRead";
import type { OcrVerifyResult } from "./ocrVerify";
import {
  BASE_LINE_KEYS,
  type AbstainLine,
  type BaseLineKey,
  type FoundLine,
  type VerifiedLine,
  type VisionLine,
  type VisionReadResult,
  type VisionVerifier,
  type VisionVerifyInput,
  type VisionVerifyResult,
} from "./types";

export const HYBRID_VERIFIER_VERSION = "v1";

// Named reasons the hybrid sets itself. Every other abstention carries the channel's own reason.
export const HYBRID_ABSTAIN = {
  disagree: "second-reads-disagree",
  modelFailed: "model-second-read-failed",
} as const;

// Which channel decided a line.
export type HybridRoute =
  | "ocr-confirmed" // OCR confirmed; no paid call for this line
  | "disagree" // OCR read a different figure; abstained, no paid call
  | "model" // OCR abstained; the model second read decided
  | "model-failed"; // OCR abstained; the model second read could not run

export interface HybridLineRecord {
  key: BaseLineKey;
  route: HybridRoute;
  ocrReason: string | null; // why OCR did not confirm, when it did not
  ocrFigure: string | null; // what OCR read in the cell, when it placed one
}

export interface HybridVerifyResult extends VisionVerifyResult {
  routes: HybridLineRecord[];
  sentToModel: BaseLineKey[]; // the lines the paid call was asked about; empty means no call
  ocrDiagnostics: OcrLineDiagnostic[];
}

// The OCR channel's shape: a verifier that also reports what it read in each cell.
export interface OcrChannel {
  readonly name: string;
  verify(input: VisionVerifyInput): Promise<OcrVerifyResult>;
}

export interface HybridDeps {
  ocr: OcrChannel;
  model: VisionVerifier;
}

// Did OCR place a figure on this line that differs from the first read? Only a figure OCR read
// counts: a cell it could not place or parse is an abstention, never a disagreement. Scale counts
// only when both captions establish one, so OCR's "Em" (which could be a euro sign) never
// disagrees on scale; it goes to the model instead.
export function ocrDisagrees(line: FoundLine, diagnostic: OcrLineDiagnostic | undefined, ocrCaption: string | null): boolean {
  if (!diagnostic || diagnostic.ocr === null) return false;
  const p = readPrintedFigure(diagnostic.ocr);
  if (!p) return false;
  const ocrValue = p.negative ? -p.magnitude : p.magnitude;
  const s1 = scaleFromCaption(line.scaleCaption);
  const s2 = scaleFromCaption(ocrCaption);
  if (s1 !== null && s2 !== null) return toPence(line.value * s1) !== toPence(ocrValue * s2);
  return ocrValue !== line.value;
}

// The first read with only `keys` left found, so the model is asked about those lines and cuts
// only their pages. Every other line is an abstention the model has nothing to say about.
export function restrictRead(read: VisionReadResult, keys: readonly BaseLineKey[]): VisionReadResult {
  const keep = new Set(keys);
  const lines = Object.fromEntries(
    BASE_LINE_KEYS.map((k) => {
      const l = read.lines[k];
      const out: VisionLine = l.status === "found" && !keep.has(k) ? { status: "abstain", reason: "decided-by-ocr-second-read" } : l;
      return [k, out];
    })
  ) as Record<BaseLineKey, VisionLine>;
  return { ...read, lines };
}

export class HybridSecondReadVerifier implements VisionVerifier {
  readonly name: string;
  constructor(private readonly deps: HybridDeps) {
    this.name = `hybrid/${HYBRID_VERIFIER_VERSION}(${deps.ocr.name}+${deps.model.name})`;
  }

  async verify(input: VisionVerifyInput): Promise<HybridVerifyResult> {
    const { read } = input;
    const found = BASE_LINE_KEYS.filter((k) => read.lines[k].status === "found");
    // OCR that throws (an unreadable cache, a broken binary) confirms nothing: every line goes to
    // the model, as if OCR had abstained on each.
    let ocr: OcrVerifyResult;
    try {
      ocr = await this.deps.ocr.verify(input);
    } catch (e) {
      const why = `OCR failed: ${e instanceof Error ? e.message : String(e)}`;
      ocr = { verifier: this.deps.ocr.name, lines: {} as OcrVerifyResult["lines"], overrides: {}, usage: null, diagnostics: [] };
      for (const k of BASE_LINE_KEYS) ocr.lines[k] = { tag: read.lines[k].status === "found" ? "rejected" : "not-checked", note: why };
    }
    const lines = { ...ocr.lines } as Record<BaseLineKey, VerifiedLine>;
    const overrides: Partial<Record<BaseLineKey, AbstainLine>> = {};
    const routes: HybridLineRecord[] = [];
    const reject = (key: BaseLineKey, reason: string) => {
      lines[key] = { tag: "rejected", note: reason };
      overrides[key] = { status: "abstain", reason };
    };

    const toModel: BaseLineKey[] = [];
    for (const key of found) {
      const line = read.lines[key] as FoundLine;
      const tag = ocr.lines[key];
      const d = ocr.diagnostics.find((x) => x.key === key);
      if (tag?.tag === "verified" && tag.evidence) {
        routes.push({ key, route: "ocr-confirmed", ocrReason: null, ocrFigure: d?.ocr ?? null });
        continue;
      }
      const ocrReason = ocr.overrides[key]?.reason ?? tag?.note ?? (d?.code ? `${d.code}: ${d.detail}` : "OCR did not confirm the line.");
      if (ocrDisagrees(line, d, captionOf(d))) {
        reject(
          key,
          `${HYBRID_ABSTAIN.disagree}: local OCR read "${d!.ocr}" on this line where the model's first read has "${line.figureText}" under ${line.scaleCaption}. The two channels disagree, so the figure is not shown and no paid second read was made.`
        );
        routes.push({ key, route: "disagree", ocrReason, ocrFigure: d!.ocr });
        continue;
      }
      toModel.push(key);
      routes.push({ key, route: "model", ocrReason, ocrFigure: d?.ocr ?? null });
    }

    let usage: LLMUsage | null = null;
    if (toModel.length > 0) {
      let model: VisionVerifyResult | null = null;
      let failure: string | null = null;
      try {
        model = await this.deps.model.verify({ ...input, read: restrictRead(read, toModel) });
      } catch (e) {
        failure = e instanceof Error ? e.message : String(e);
      }
      usage = model?.usage ?? null;
      for (const key of toModel) {
        const route = routes.find((r) => r.key === key)!;
        const ocrWords = ocrAside(route);
        if (!model) {
          route.route = "model-failed";
          reject(key, `${HYBRID_ABSTAIN.modelFailed}: local OCR abstained and the model second read failed (${failure}), so the figure is not shown.${ocrWords}`);
          continue;
        }
        const m = model.lines[key];
        if (m?.tag === "verified" && m.evidence) {
          lines[key] = { ...m, note: `${m.note ?? ""}${ocrWords}` };
          continue;
        }
        const reason = model.overrides[key]?.reason ?? m?.note ?? "The model second read did not confirm this line.";
        // A model that could not read at all rejects every line with the same "No second read"
        // reason; that is still the model deciding, and its words say why.
        if (/^(No second read|The second read came back in a shape)/.test(reason)) route.route = "model-failed";
        reject(key, `${reason}${ocrWords}`);
      }
    }

    return {
      verifier: this.name,
      lines,
      overrides,
      usage,
      routes,
      sentToModel: toModel,
      ocrDiagnostics: ocr.diagnostics,
    };
  }
}

function captionOf(d: OcrLineDiagnostic | undefined): string | null {
  return d ? (/caption "([^"]*)"/.exec(d.detail)?.[1] ?? null) : null;
}

function ocrAside(r: HybridLineRecord): string {
  if (r.ocrFigure !== null && readPrintedFigure(r.ocrFigure)) return ` Local OCR read the same figure, "${r.ocrFigure}", but could not confirm it: ${r.ocrReason}`;
  return ` Local OCR abstained first: ${r.ocrReason}`;
}
