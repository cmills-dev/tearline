// eval/gold/uk-hybrid-verify.ts (WP-OCR3)
// The hybrid second read (OCR first, the model only where OCR abstains), scored on the frozen UK gold
// set beside the model second read alone and OCR alone.
//
// For every figure a recorded first read surfaced it reports which channel decided it (OCR
// confirmed, OCR disagreed, sent to the model), whether each mode would show it, and the gold
// figure. It counts the lines and pages that would still need a paid call.
//
// The model second read is the recorded one. Those recordings were made for every found line of a
// filing, on all its cited pages, so here the model channel judges the recording against the whole
// first read and the hybrid takes its verdict only for the lines it sent. A live hybrid call is
// asked about fewer lines on fewer pages; its ties can then only run among those lines, so a tie
// with a line OCR confirmed shows as "not run" rather than pass or fail. The report says so.
//
// The page layers are the stored ones in eval/gold/uk/ocr/. It OCRs nothing, calls no model and
// uses no network. It fails the run (exit 1) if the hybrid shows a figure the gold set disagrees
// with that the model second read alone would not have shown, or if OCR confirms any such figure:
// the hybrid must never be less safe than the default it would replace.
//
// Run: ./node_modules/.bin/tsx eval/gold/uk-hybrid-verify.ts

import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { InMemoryCache } from "../../lib/cache/cache";
import { diskPageSource } from "../../lib/ocr/pageLayer";
import { OcrSecondReadVerifier } from "../../lib/vision/ocrVerify";
import { HybridSecondReadVerifier, type HybridRoute } from "../../lib/vision/hybridVerify";
import { scaleFromCaption, toPence } from "../../lib/vision/scale";
import { BASE_LINE_KEYS, type BaseLineKey, type FoundLine, type VisionReadResult, type VisionVerifier, type VisionVerifyResult } from "../../lib/vision/types";
import { DoubleReadVerifier, DOUBLE_READ_VERIFIER_NAME, applyVerification } from "../../lib/vision/verify";
import { visionLines } from "../../lib/sources/visionAccounts";
import type { AccountsTypeLabel } from "../../lib/resolve/accountsType";
import { UK_GOLD, isPersonChecked } from "./uk";
import { replayFirstRead } from "./ukReplay";

const here = dirname(fileURLToPath(import.meta.url));
const OCR_DIR = join(here, "uk", "ocr");

type GoldVerdict = "first-right" | "first-wrong" | "gold-abstain" | "no-gold";

export interface HybridRow {
  company: string;
  key: BaseLineKey;
  page: number;
  first: string;
  caption: string;
  route: HybridRoute;
  ocrShown: boolean;
  modelShown: boolean;
  hybridShown: boolean;
  why: string; // the hybrid's reason, when it did not show the figure
  gold: GoldVerdict;
  goldText: string;
}

export interface FilingCost {
  company: string;
  found: number;
  sent: number;
  modelPages: number; // pages the model second read alone is sent
  hybridPages: number; // pages the hybrid still sends
}

const pounds = (value: number, caption: string | null | undefined): number | null => {
  const s = scaleFromCaption(caption);
  return s === null ? null : toPence(value * s);
};

const pagesOf = (read: VisionReadResult, keys: readonly BaseLineKey[]) =>
  new Set(keys.map((k) => (read.lines[k] as FoundLine).pdfPageIndex)).size;

// The recorded model second read, judged against the whole first read it was recorded for.
function recordedModel(full: VisionReadResult, model: DoubleReadVerifier): VisionVerifier {
  let memo: Promise<VisionVerifyResult> | null = null;
  return {
    name: DOUBLE_READ_VERIFIER_NAME,
    verify(input) {
      memo ??= model.verify({ ...input, read: full });
      return memo;
    },
  };
}

export async function scoreHybridOnGold(): Promise<{ rows: HybridRow[]; costs: FilingCost[]; unvalidated: string[] }> {
  const rows: HybridRow[] = [];
  const costs: FilingCost[] = [];
  const unvalidated: string[] = [];
  const pages = diskPageSource({ dir: OCR_DIR, bin: null });
  for (const g of UK_GOLD.filter((c) => c.scan)) {
    const r = await replayFirstRead(g);
    if (!r) continue;
    // A recorded first read that no longer validates (recorded under an older prompt or schema)
    // is not a replay: it surfaces nothing, and counting it would print zeros as if measured.
    if (r.read.outcome !== "read") {
      unvalidated.push(`${g.name}: ${r.read.outcome}`);
      continue;
    }
    const accountsType: AccountsTypeLabel | null = r.accountsType;
    const input = { read: r.read, pdfBytes: r.pdfBytes.slice(), pageCount: g.pageCount, accountsType };
    const shown = (v: VisionVerifyResult) => {
      const a = applyVerification(r.read, v);
      const lines = visionLines(a.read, a.tags, g.madeUpDate, accountsType ? { accountsType } : {});
      return new Set(lines.figures.map((f) => f.key));
    };

    const ocr = await new OcrSecondReadVerifier({ pages }).verify(input);
    const model = await new DoubleReadVerifier({ provider: r.secondReader, cache: new InMemoryCache() }).verify({ ...input, pdfBytes: r.pdfBytes.slice() });
    const hybrid = await new HybridSecondReadVerifier({
      ocr: new OcrSecondReadVerifier({ pages }),
      model: recordedModel(r.read, new DoubleReadVerifier({ provider: r.secondReader, cache: new InMemoryCache() })),
    }).verify({ ...input, pdfBytes: r.pdfBytes.slice() });
    const [ocrShown, modelShown, hybridShown] = [shown(ocr), shown(model), shown(hybrid)];

    const found = BASE_LINE_KEYS.filter((k) => r.read.lines[k].status === "found");
    costs.push({ company: g.name, found: found.length, sent: hybrid.sentToModel.length, modelPages: pagesOf(r.read, found), hybridPages: pagesOf(r.read, hybrid.sentToModel) });

    for (const key of found) {
      const line = r.read.lines[key] as FoundLine;
      const goldFig = g.figures.find((f) => f.metric === key && f.method === "agent-read" && !f.document);
      let gold: GoldVerdict = "no-gold";
      let goldText = "";
      if (goldFig) {
        goldText = `${goldFig.printedText} ${goldFig.scaleCaption} p${goldFig.pdfPage}${isPersonChecked(goldFig) ? " [person-checked]" : ` [${goldFig.status}]`}`;
        if (goldFig.value === "ABSTAIN") gold = "gold-abstain";
        else {
          const firstPounds = pounds(line.value, line.scaleCaption);
          gold = firstPounds !== null && Math.abs(firstPounds - goldFig.value) < 0.01 ? "first-right" : "first-wrong";
        }
      }
      const hybridIsShown = hybridShown.has(key);
      rows.push({
        company: g.name,
        key,
        page: line.pdfPageIndex,
        first: line.figureText,
        caption: line.scaleCaption,
        route: hybrid.routes.find((x) => x.key === key)!.route,
        ocrShown: ocrShown.has(key),
        modelShown: modelShown.has(key),
        hybridShown: hybridIsShown,
        why: hybridIsShown ? "" : (hybrid.overrides[key]?.reason ?? hybrid.lines[key].note ?? ""),
        gold,
        goldText,
      });
    }
  }
  return { rows, costs, unvalidated };
}

async function main() {
  const { rows, costs, unvalidated } = await scoreHybridOnGold();
  const n = (f: (r: HybridRow) => boolean) => rows.filter(f).length;
  const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(0)}%` : "-");
  const sum = (f: (c: FilingCost) => number) => costs.reduce((s, c) => s + f(c), 0);
  console.log("\nUK gold: the hybrid second read, OCR first  (eval/gold/uk-hybrid-verify.ts)\n" + "=".repeat(78));
  console.log(`filings replayed                 ${costs.length}`);
  if (unvalidated.length) {
    console.log(`NOT REPLAYED: ${unvalidated.length} recorded first read(s) no longer validate. Recorded under an older prompt or schema; re-record (npm run eval:uk:live -- --spend).`);
    for (const u of unvalidated) console.log(`  ${u}`);
  }
  console.log(`figures the first read surfaced  ${rows.length}`);
  console.log(`routes: OCR confirmed ${n((r) => r.route === "ocr-confirmed")}, OCR disagreed ${n((r) => r.route === "disagree")}, sent to the model ${n((r) => r.route === "model" || r.route === "model-failed")}`);
  console.log(`confirmed: model alone ${n((r) => r.modelShown)}   OCR alone ${n((r) => r.ocrShown)}   hybrid ${n((r) => r.hybridShown)}`);
  console.log(`  hybrid confirmed by OCR ${n((r) => r.hybridShown && r.route === "ocr-confirmed")}, by the model ${n((r) => r.hybridShown && r.route === "model")}`);
  console.log(`  model alone confirmed, hybrid did not  ${n((r) => r.modelShown && !r.hybridShown)}`);
  console.log(`  hybrid confirmed, model alone did not  ${n((r) => r.hybridShown && !r.modelShown)}`);
  console.log(`abstained: model alone ${n((r) => !r.modelShown)}   hybrid ${n((r) => !r.hybridShown)}`);
  console.log("-".repeat(78));
  const withGold = rows.filter((r) => r.gold !== "no-gold");
  const wrong = (f: (r: HybridRow) => boolean) => withGold.filter((r) => f(r) && r.gold !== "first-right");
  console.log(`against gold (${withGold.length} surfaced figures carry a gold figure; none is person-checked unless marked):`);
  console.log(`  confirmed although gold disagrees: model ${wrong((r) => r.modelShown).length}   OCR ${wrong((r) => r.ocrShown).length}   hybrid ${wrong((r) => r.hybridShown).length}`);
  console.log(`  first read's right figures confirmed: model ${n((r) => r.gold === "first-right" && r.modelShown)}   OCR ${n((r) => r.gold === "first-right" && r.ocrShown)}   hybrid ${n((r) => r.gold === "first-right" && r.hybridShown)}   of ${n((r) => r.gold === "first-right")}`);
  console.log("-".repeat(78));
  console.log(`paid calls: lines ${sum((c) => c.sent)} of ${sum((c) => c.found)} (${pct(sum((c) => c.sent), sum((c) => c.found))}), pages ${sum((c) => c.hybridPages)} of ${sum((c) => c.modelPages)} (${pct(sum((c) => c.hybridPages), sum((c) => c.modelPages))}), filings needing a call ${costs.filter((c) => c.sent > 0).length} of ${costs.length}`);
  for (const c of costs) console.log(`  ${c.company.slice(0, 22).padEnd(22)} lines ${String(c.sent).padStart(2)} of ${String(c.found).padStart(2)}   pages ${c.hybridPages} of ${c.modelPages}`);
  console.log("\nPer figure (route, model alone / hybrid):");
  for (const r of rows) {
    const v = `${r.modelShown ? "model✓" : "model·"} ${r.hybridShown ? "hybrid✓" : "hybrid·"}`;
    console.log(`  ${r.route.padEnd(13)} ${v}  ${r.company.slice(0, 18).padEnd(18)} ${r.key.padEnd(26)} p${String(r.page).padEnd(4)} ${`"${r.first}" ${r.caption}`.padEnd(20)} gold ${r.gold.padEnd(12)} ${r.goldText}`);
    if (!r.hybridShown) console.log(`${" ".repeat(16)}why not: ${r.why.slice(0, 220)}`);
  }
  console.log("");
  const worse = wrong((r) => r.hybridShown && !r.modelShown);
  const ocrWrong = wrong((r) => r.ocrShown);
  if (worse.length || ocrWrong.length) {
    console.log(`FAIL: the hybrid confirmed ${worse.length} figure(s) the gold set disagrees with that the model alone did not; OCR confirmed ${ocrWrong.length}.`);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
