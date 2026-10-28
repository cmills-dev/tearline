// eval/gold/uk-verify.ts
// The double read (WP-BE05) scored against the UK gold set, offline.
//
// For each frozen scan with a recorded first read and a recorded second read, this replays both
// through the real verifier and mapper and compares what surfaces with the agent-read gold
// figures. Precision and the abstain rate are reported separately and never added together.
//
// WP-BE17: precision is reported per gold label (claude-checked, tie-checked, candidate, and the
// cam-* labels when Cam's pass exists), and the header counts person-checked figures from the
// data (isPersonChecked), so the output cannot say a person verified anything the data does not
// say. A gold value of "ABSTAIN" scores an abstention as right and a surfaced figure as wrong.
// The three large group filings replay their WP-BE15/WP-BE18 recordings
// (test/fixtures/vision/pages/), page-finding included, with accountsType "group" as they were
// recorded. The first five replay as WP-BE05 recorded them, with no accountsType.
//
// Every agent-read gold figure is still machine-keyed, so a difference between the verifier and
// the gold set is listed as a disagreement to look at, not scored as the verifier being wrong,
// and it does not fail this script. The gate on the UK set belongs to WP-BE13. No network, no
// model call.
//
// Run: ./node_modules/.bin/tsx eval/gold/uk-verify.ts

import { existsSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { InMemoryCache } from "../../lib/cache/cache";
import { AnthropicProvider } from "../../lib/llm/providers/anthropic";
import { readScannedAccounts } from "../../lib/vision/client";
import { DoubleReadVerifier, applyVerification } from "../../lib/vision/verify";
import { visionLines } from "../../lib/sources/visionAccounts";
import { BASE_LINE_KEYS } from "../../lib/vision/types";
import { stageOf } from "../../test/pageFindingCases";
import { UK_GOLD, STATUS_MEANING, isPersonChecked, type UkFigureStatus } from "./uk";

const here = dirname(fileURLToPath(import.meta.url));
const FX = join(here, "..", "..", "test", "fixtures", "vision");

// The recorded reads. Bristol Water and Matalan reuse the WP-BE01 first reads (prompt p1).
const RECORDED: Record<string, { first: string; second: string }> = {
  "02662226": { first: "bristol-water-02662226.json", second: "verify/02662226-second.json" },
  "02103564": { first: "matalan-retail-02103564.json", second: "verify/02103564-second.json" },
  "01404552": { first: "verify/01404552-first.json", second: "verify/01404552-second.json" },
  "00769170": { first: "verify/00769170-first.json", second: "verify/00769170-second.json" },
  "03558065": { first: "verify/03558065-first.json", second: "verify/03558065-second.json" },
};
// Page-finding recordings (WP-BE15, re-recorded by WP-BE18 on 22 Sep 2026).
const PAGED = ["03213782", "00211475", "00445790"];

function replay(response: unknown): AnthropicProvider {
  return new AnthropicProvider(
    { provider: "anthropic", model: "claude-opus-5", apiKey: "replay", maxTokens: 1024 },
    {
      fetchImpl: async () => new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } }),
      logUsage: () => {},
    }
  );
}

function replayByStage(byStage: Map<string, unknown>, model: string): AnthropicProvider {
  return new AnthropicProvider(
    { provider: "anthropic", model, apiKey: "replay", maxTokens: 1024 },
    {
      fetchImpl: async (_u: unknown, init?: RequestInit) => {
        const stage = stageOf(JSON.parse(String(init?.body)));
        const response = byStage.get(stage);
        if (!response) throw new Error(`no recorded response for ${stage}`);
        return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
      },
      logUsage: () => {},
    }
  );
}

const load = (rel: string) => JSON.parse(readFileSync(join(FX, rel), "utf8"));
const gbp = (n: number) => `${n < 0 ? "-" : ""}£${Math.abs(n).toLocaleString("en-GB")}`;

type Outcome = "agrees" | "disagrees" | "abstained" | "abstained-rightly" | "surfaced-wrongly";

interface Row {
  company: string;
  metric: string;
  status: UkFigureStatus;
  gold: number | "ABSTAIN";
  outcome: Outcome;
  detail: string;
}

async function replayCase(g: (typeof UK_GOLD)[number]) {
  const bytes = new Uint8Array(readFileSync(join(here, "fixtures", "uk", g.folder, "filing.pdf")));
  const input = { pdfBytes: bytes, transactionId: g.transactionId, companyNumber: g.companyNumber, pageCount: g.pageCount };
  const rec = RECORDED[g.companyNumber];
  if (rec) {
    const read = await readScannedAccounts(input, { provider: replay(load(rec.first).response), cache: new InMemoryCache(), pageFindingAbovePages: 200 });
    const verification = await new DoubleReadVerifier({ provider: replay(load(rec.second).response), cache: new InMemoryCache() }).verify({
      read,
      pdfBytes: bytes.slice(),
      pageCount: g.pageCount,
    });
    const applied = applyVerification(read, verification);
    return { read, out: visionLines(applied.read, applied.tags, g.madeUpDate) };
  }
  const path = join(FX, "pages", `${g.companyNumber}.json`);
  if (!PAGED.includes(g.companyNumber) || !existsSync(path)) return null;
  const paged = JSON.parse(readFileSync(path, "utf8"));
  if (!paged.calls.length || !paged.calls.every((c: any) => c.status === 200)) return null;
  const byStage = new Map<string, unknown>(paged.calls.map((c: any) => [c.stage, c.response]));
  const reader = replayByStage(byStage, paged.readerModel);
  const cache = new InMemoryCache();
  const read = await readScannedAccounts(input, { provider: reader, pageFinder: replayByStage(byStage, paged.finderModel), cache });
  const accountsType = "group" as const;
  const verification = await new DoubleReadVerifier({ provider: reader, cache }).verify({ read, pdfBytes: bytes.slice(), pageCount: g.pageCount, accountsType });
  const applied = applyVerification(read, verification);
  return { read, out: visionLines(applied.read, applied.tags, g.madeUpDate, { accountsType }) };
}

async function main() {
  const rows: Row[] = [];
  const unscored: string[] = [];
  const notReplayed: string[] = [];
  let foundLines = 0;
  let surfacedLines = 0;
  let replayed = 0;

  for (const g of UK_GOLD.filter((c) => c.scan)) {
    const goldFigures = g.figures.filter(
      (f) => f.method === "agent-read" && !f.document && (BASE_LINE_KEYS as readonly string[]).includes(f.metric)
    );
    const m = await replayCase(g);
    if (!m) {
      if (goldFigures.length > 0) notReplayed.push(`${g.name} (${goldFigures.length} gold base-line figures): no recorded read`);
      continue;
    }
    replayed++;
    const { read, out } = m;
    foundLines += BASE_LINE_KEYS.filter((k) => read.lines[k].status === "found").length;
    surfacedLines += out.figures.length;

    for (const f of goldFigures) {
      const fig = out.figures.find((x) => x.key === f.metric);
      const base = { company: g.name, metric: f.metric, status: f.status, gold: f.value };
      if (!fig) {
        const why = out.abstentions.find((a) => a.key === f.metric)?.reason ?? "not returned";
        rows.push({ ...base, outcome: f.value === "ABSTAIN" ? "abstained-rightly" : "abstained", detail: why });
        continue;
      }
      // Gold keeps the printed sign; the evidence carries the agreed figure with its printed sign.
      const pounds = fig.tag.evidence!.pounds;
      const where = `surfaced "${fig.line.figureText}" ${fig.line.scaleCaption} on PDF page ${fig.line.pdfPageIndex} (${fig.line.printedLabel ?? ""})`;
      if (f.value === "ABSTAIN") {
        rows.push({ ...base, outcome: "surfaced-wrongly", detail: `${where}; gold says abstain` });
        continue;
      }
      const same = Math.abs(pounds - f.value) < 0.01;
      rows.push({
        ...base,
        outcome: same ? "agrees" : "disagrees",
        detail: same ? fig.tags.join(", ") : `${where}; gold "${f.printedText}" ${f.scaleCaption} on PDF page ${f.pdfPage} (${f.printedLabel ?? ""})`,
      });
    }
    for (const fig of out.figures) {
      if (!goldFigures.some((f) => f.metric === fig.key)) unscored.push(`${g.name} ${fig.key} ${gbp(fig.tag.evidence!.pounds)} (${fig.tags.join(", ")})`);
    }
  }

  const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "n/a");
  const count = (rs: Row[], o: Outcome[]) => rs.filter((r) => o.includes(r.outcome)).length;
  const allFigures = UK_GOLD.flatMap((c) => c.figures);
  const personChecked = allFigures.filter(isPersonChecked).length;

  console.log("\nUK gold: the double read  (eval/gold/uk-verify.ts)\n" + "=".repeat(72));
  console.log(`gold figures checked by a person (cam-checked, cam-corrected)   ${personChecked} of ${allFigures.length}`);
  if (personChecked === 0) console.log("NO FIGURE IN THIS SET HAS BEEN CHECKED BY A PERSON. claude-checked is a machine check.");
  console.log(`filings replayed               ${replayed}`);
  console.log(`gold base-line figures scored  ${rows.length}`);
  console.log("-".repeat(72));
  console.log("Precision by gold label (right surfaced / all surfaced; a surfaced figure whose gold is ABSTAIN is wrong):");
  const order: UkFigureStatus[] = ["cam-checked", "cam-corrected", "claude-checked", "tie-checked", "candidate"];
  for (const s of order) {
    const rs = rows.filter((r) => r.status === s);
    if (!rs.length) {
      console.log(`  ${s.padEnd(15)} no scored figures`);
      continue;
    }
    const right = count(rs, ["agrees"]);
    const surfaced = count(rs, ["agrees", "disagrees", "surfaced-wrongly"]);
    const valued = count(rs, ["agrees", "disagrees", "abstained"]);
    const abstainGold = count(rs, ["abstained-rightly", "surfaced-wrongly"]);
    console.log(
      `  ${s.padEnd(15)} precision ${pct(right, surfaced).padEnd(6)} (${right} of ${surfaced} surfaced)   abstained ${count(rs, ["abstained"])} of ${valued} with a value   ABSTAIN gold rightly abstained ${count(rs, ["abstained-rightly"])} of ${abstainGold}`
    );
    console.log(`  ${"".padEnd(15)} ${STATUS_MEANING[s]}`);
  }
  const right = count(rows, ["agrees"]);
  const surfaced = count(rows, ["agrees", "disagrees", "surfaced-wrongly"]);
  console.log("-".repeat(72));
  console.log(`All machine-checked labels together, for comparison with WP-BE05 only: ${pct(right, surfaced)} (${right} of ${surfaced}). No person checked these.`);
  console.log(`ABSTAIN RATE on gold figures with a value   ${pct(count(rows, ["abstained"]), count(rows, ["agrees", "disagrees", "abstained"]))}`);
  console.log(`ABSTAIN RATE on all first-read lines        ${pct(foundLines - surfacedLines, foundLines)}   (${foundLines - surfacedLines} of ${foundLines})`);

  console.log("\nPer gold figure:");
  for (const r of rows) {
    const gold = r.gold === "ABSTAIN" ? "ABSTAIN" : gbp(r.gold);
    console.log(`  ${r.outcome.padEnd(17)} ${r.company.slice(0, 22).padEnd(22)} ${r.metric.padEnd(26)} gold ${gold.padEnd(17)} [${r.status}]  ${r.detail}`);
  }
  console.log("\nSurfaced with no gold figure to score against:");
  for (const u of unscored) console.log(`  ${u}`);
  if (notReplayed.length) {
    console.log("\nNot replayed:");
    for (const n of notReplayed) console.log(`  ${n}`);
  }
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
