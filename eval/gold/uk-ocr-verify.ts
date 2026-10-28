// eval/gold/uk-ocr-verify.ts (WP-OCR2)
// The second read on local OCR, scored on the frozen UK gold set, beside the recorded model second
// read it would replace.
//
// For every figure a recorded first read surfaced, it reports:
//   - what OCR read at the cited row and the period column: agree (same value, sign and scale as
//     the first read), disagree (a different figure), or unreadable (it could not place one, with
//     the named reason);
//   - whether the OCR verifier confirmed the figure (the full judgement: scale caption, currency,
//     period, basis, ties) and whether the recorded model second read did;
//   - the gold figure, so a confirmation of a figure the gold set disagrees with is counted.
//
// The page layers are the stored ones in eval/gold/uk/ocr/ (eval/gold/uk/ocr-pages.ts made them).
// It OCRs nothing, calls no model, and uses no network. A figure the OCR verifier confirms that
// disagrees with a gold figure fails the run (exit 1): that is the one thing it must never do.
//
// Run: ./node_modules/.bin/tsx eval/gold/uk-ocr-verify.ts

import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { InMemoryCache } from "../../lib/cache/cache";
import { diskPageSource } from "../../lib/ocr/pageLayer";
import { OcrSecondReadVerifier } from "../../lib/vision/ocrVerify";
import { scaleFromCaption, toPence } from "../../lib/vision/scale";
import { readPrintedFigure } from "../../lib/vision/schema";
import { BASE_LINE_KEYS, type FoundLine, type VerifiedLine } from "../../lib/vision/types";
import { DoubleReadVerifier, applyVerification } from "../../lib/vision/verify";
import { visionLines } from "../../lib/sources/visionAccounts";
import { UK_GOLD, isPersonChecked } from "./uk";
import { replayFirstRead } from "./ukReplay";

const here = dirname(fileURLToPath(import.meta.url));
const OCR_DIR = join(here, "uk", "ocr");

export type OcrOutcome = "agree" | "disagree" | "unreadable";
type GoldVerdict = "first-right" | "first-wrong" | "gold-abstain" | "no-gold";

export interface OcrRow {
  company: string;
  key: string;
  page: number;
  first: string;
  caption: string;
  ocr: string | null;
  outcome: OcrOutcome;
  reason: string;
  ocrVerified: boolean;
  ocrNote: string;
  modelVerified: boolean;
  gold: GoldVerdict;
  goldText: string;
}

const pounds = (value: number, caption: string | null | undefined): number | null => {
  const s = scaleFromCaption(caption);
  return s === null ? null : toPence(value * s);
};

export async function scoreOcrOnGold(): Promise<{ rows: OcrRow[]; filings: string[]; unvalidated: string[] }> {
  const rows: OcrRow[] = [];
  const filings: string[] = [];
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
    filings.push(g.name);
    const input = { read: r.read, pdfBytes: r.pdfBytes.slice(), pageCount: g.pageCount, accountsType: r.accountsType };
    const ocr = await new OcrSecondReadVerifier({ pages }).verify(input);
    const ocrApplied = applyVerification(r.read, ocr);
    const ocrShown = visionLines(ocrApplied.read, ocrApplied.tags, g.madeUpDate, r.accountsType ? { accountsType: r.accountsType } : {});
    const model = await new DoubleReadVerifier({ provider: r.secondReader, cache: new InMemoryCache() }).verify({ ...input, pdfBytes: r.pdfBytes.slice() });
    const modelApplied = applyVerification(r.read, model);
    const modelShown = visionLines(modelApplied.read, modelApplied.tags, g.madeUpDate, r.accountsType ? { accountsType: r.accountsType } : {});

    for (const key of BASE_LINE_KEYS) {
      const line = r.read.lines[key];
      if (line.status !== "found") continue;
      const d = ocr.diagnostics.find((x) => x.key === key)!;
      const wire = key; // for readability below
      void wire;
      let outcome: OcrOutcome = "unreadable";
      let reason = d.code ? `${d.code}: ${d.detail}` : d.detail;
      if (d.ocr !== null) {
        const p = readPrintedFigure(d.ocr);
        const ocrValue = p ? (p.negative ? -p.magnitude : p.magnitude) : null;
        const caption = /caption "([^"]*)"/.exec(d.detail)?.[1] ?? "";
        const a = pounds((line as FoundLine).value, line.scaleCaption);
        const b = ocrValue === null ? null : pounds(ocrValue, caption);
        const same = a !== null && b !== null ? a === b : ocrValue === (line as FoundLine).value;
        outcome = same ? "agree" : "disagree";
      }
      const tag: VerifiedLine = ocr.lines[key];
      const ocrVerified = ocrShown.figures.some((f) => f.key === key);
      const modelVerified = modelShown.figures.some((f) => f.key === key);
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
      if (!ocrVerified && tag.tag === "rejected" && outcome !== "unreadable") reason = tag.note ?? reason;
      rows.push({
        company: g.name,
        key,
        page: line.pdfPageIndex,
        first: `${line.figureText}`,
        caption: line.scaleCaption,
        ocr: d.ocr,
        outcome,
        reason,
        ocrVerified,
        ocrNote: tag.note ?? "",
        modelVerified,
        gold,
        goldText,
      });
    }
  }
  return { rows, filings, unvalidated };
}

async function main() {
  const { rows, filings, unvalidated } = await scoreOcrOnGold();
  const n = (f: (r: OcrRow) => boolean) => rows.filter(f).length;
  console.log("\nUK gold: the second read on local OCR  (eval/gold/uk-ocr-verify.ts)\n" + "=".repeat(78));
  console.log(`filings replayed                 ${filings.length}`);
  if (unvalidated.length) {
    console.log(`NOT REPLAYED: ${unvalidated.length} recorded first read(s) no longer validate. Recorded under an older prompt or schema; re-record (npm run eval:uk:live -- --spend).`);
    for (const u of unvalidated) console.log(`  ${u}`);
  }
  console.log(`figures the first read surfaced  ${rows.length}`);
  console.log(`OCR at the cited row and period column: agree ${n((r) => r.outcome === "agree")}, disagree ${n((r) => r.outcome === "disagree")}, unreadable ${n((r) => r.outcome === "unreadable")}`);
  console.log(`confirmed after every check:     OCR ${n((r) => r.ocrVerified)}   recorded model second read ${n((r) => r.modelVerified)}`);
  console.log(`confirmed by both                ${n((r) => r.ocrVerified && r.modelVerified)}   OCR only ${n((r) => r.ocrVerified && !r.modelVerified)}   model only ${n((r) => !r.ocrVerified && r.modelVerified)}`);
  const withGold = rows.filter((r) => r.gold === "first-right" || r.gold === "first-wrong" || r.gold === "gold-abstain");
  const bad = (v: "ocrVerified" | "modelVerified") => withGold.filter((r) => r[v] && r.gold !== "first-right");
  console.log("-".repeat(78));
  console.log(`against gold (${withGold.length} surfaced figures carry a gold figure; none is person-checked unless marked):`);
  console.log(`  first read right ${n((r) => r.gold === "first-right")}, wrong ${n((r) => r.gold === "first-wrong")}, gold says abstain ${n((r) => r.gold === "gold-abstain")}`);
  console.log(`  OCR confirmed a figure the gold set disagrees with:   ${bad("ocrVerified").length}   <- must be 0`);
  console.log(`  model confirmed a figure the gold set disagrees with: ${bad("modelVerified").length}`);
  console.log(`  OCR confirmed of the first read's right figures:      ${n((r) => r.gold === "first-right" && r.ocrVerified)} of ${n((r) => r.gold === "first-right")}   (model ${n((r) => r.gold === "first-right" && r.modelVerified)})`);
  console.log(`  OCR disagreed where the first read was wrong:         ${n((r) => r.gold !== "first-right" && r.gold !== "no-gold" && r.outcome === "disagree")} of ${n((r) => r.gold === "first-wrong" || r.gold === "gold-abstain")}`);
  console.log("\nPer figure:");
  for (const r of rows) {
    const v = `${r.ocrVerified ? "OCR✓" : "OCR·"} ${r.modelVerified ? "model✓" : "model·"}`;
    console.log(
      `  ${r.outcome.padEnd(10)} ${v}  ${r.company.slice(0, 18).padEnd(18)} ${r.key.padEnd(26)} p${String(r.page).padEnd(4)} first ${`"${r.first}" ${r.caption}`.padEnd(20)} ocr ${String(r.ocr ?? "-").padEnd(13)} gold ${r.gold.padEnd(12)} ${r.goldText}`
    );
    if (!r.ocrVerified) console.log(`${" ".repeat(14)}why not confirmed: ${r.outcome === "agree" ? r.ocrNote : r.reason}`);
  }
  console.log("");
  const fatal = bad("ocrVerified");
  if (fatal.length) {
    console.log(`FAIL: OCR confirmed ${fatal.length} figure(s) the gold set disagrees with.`);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
