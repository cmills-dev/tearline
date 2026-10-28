// test/record/debtNotes.ts
// Record the live debt-note reads that test/capitalStructure.test.ts replays (WP-BE16). This makes
// paid calls. It is never run by `npm test`.
//
// Run from product/, with the key in .env.local:
//   ./node_modules/.bin/tsx --env-file=.env.local test/record/debtNotes.ts gold    # the debt-note gold
//   ./node_modules/.bin/tsx --env-file=.env.local test/record/debtNotes.ts large   # timing on the large three
//
// gold: the two gold filings that carry debt-note facilities.
//   - Boparan (113 pages): its WP-BE05 first read is replayed from test/fixtures/vision/verify, and
//     only the facility read is live.
//   - Solid State (140 pages): no read was ever recorded, so page-finding, the first read, the
//     line second read and the facility read are all live, the last two side by side as in
//     production. Its wall time is a true end-to-end measurement.
// large: the three large group scans of WP-BE15 and WP-BE18. Their page-finding, first read and
//   line second read are replayed from test/fixtures/vision/pages; only the facility read is live,
//   run beside the replayed second read. The time a live run would take is then the recorded
//   page-finding and first read, plus the longer of the recorded second read and the live facility
//   read. That is a composition of measurements, and the report says so.
//
// Each filing writes test/fixtures/vision/facilities/<company number>.json: the raw Messages API
// responses (no PDF bytes, no key, no header) and the time and cost of each stage. The run stops
// before a filing once it, plus ALREADY_SPENT_GBP, has reached GBP 2.40.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { InMemoryCache } from "../../lib/cache/cache";
import { getLLMConfig } from "../../lib/llm/config";
import { AnthropicProvider } from "../../lib/llm/providers/anthropic";
import type { LLMUsage } from "../../lib/llm/types";
import { readScannedAccounts } from "../../lib/vision/client";
import { DoubleReadVerifier } from "../../lib/vision/verify";
import { DebtNoteFacilityReader } from "../../lib/vision/capitalStructure";
import { PAGE_FINDER_MODEL_DEFAULT } from "../../lib/vision/pages";
import type { VisionReadResult } from "../../lib/vision/types";
import { stageOf, LARGE_FILINGS } from "../pageFindingCases";

const here = dirname(fileURLToPath(import.meta.url));
const GOLD = join(here, "..", "..", "eval", "gold", "fixtures", "uk");
const FX = join(here, "..", "fixtures", "vision");
const OUT = join(FX, "facilities");
const CAP_GBP = 2.4;

interface Recorded {
  stage: string;
  model: string;
  response: unknown;
  status: number;
}

// Live calls are recorded; with `replayFrom`, a stage that has a recorded answer is served from it
// and never sent.
function provider(model: string, calls: Recorded[], usages: LLMUsage[], replayFrom?: Map<string, unknown>): AnthropicProvider {
  const config = { ...getLLMConfig(), model };
  return new AnthropicProvider(config, {
    fetchImpl: async (url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const stage = stageOf(body);
      const replayed = replayFrom?.get(stage);
      if (replayed) {
        return new Response(JSON.stringify(replayed), { status: 200, headers: { "content-type": "application/json" } });
      }
      const res = await fetch(url as string, init);
      const text = await res.text();
      let response: unknown = null;
      try {
        response = JSON.parse(text);
      } catch {
        response = null;
      }
      calls.push({ stage, model, response: res.ok ? response : { error: `HTTP ${res.status}` }, status: res.status });
      return new Response(text, { status: res.status, headers: res.headers });
    },
    logUsage: (u) => {
      // A replayed answer reports its recorded usage too, but costs nothing now. In every replaying
      // mode here the facility read is the only live call, so only it is counted.
      if (replayFrom && !u.label?.startsWith("vision-facilities")) return;
      usages.push(u);
      console.log(`  usage ${u.label ?? ""} ${u.model} in ${u.inputTokens} out ${u.outputTokens} ${(u.durationMs / 1000).toFixed(1)}s GBP ${u.costGbp?.toFixed(4)}`);
    },
  });
}

const gbpOf = (usages: LLMUsage[]) => usages.reduce((s, u) => s + (u.costGbp ?? 0), 0);

function printTable(read: VisionReadResult, table: Awaited<ReturnType<DebtNoteFacilityReader["read"]>>["table"]) {
  console.log(`  first read debt note: ${read.debtNote.status}${read.debtNote.status === "found" ? `, ${read.debtNote.facilities.length} facilities, pages ${read.debtNote.pdfPageIndexes.join(",")}` : ` (${read.debtNote.reason})`}`);
  console.log(`  table ${table.status}${table.reason ? `: ${table.reason}` : ""}; note "${table.noteHeading ?? ""}", caption ${table.scaleCaption ?? "none"}`);
  for (const r of table.rows) {
    console.log(`  ROW ${r.status} "${r.name}" (${r.type}) p${r.page}${r.reason ? `: ${r.reason}` : ""}`);
    for (const [k, c] of Object.entries(r.cells)) {
      console.log(`     ${k}: ${c.status}${c.text ? ` "${c.text}"` : ""}${c.pounds !== null ? ` = ${c.pounds}` : ""}${c.reason ? ` | ${c.reason.slice(0, 160)}` : ""}`);
    }
  }
  for (const n of table.notes) console.log(`  note: ${n}`);
}

async function gold(spentBefore: number, readerModel: string, finderModel: string): Promise<number> {
  let spent = spentBefore;

  // Boparan: replayed first read, live facility read.
  if (spent < CAP_GBP) {
    const number = "03558065";
    console.log(`\nBoparan Holdings ${number}`);
    const bytes = new Uint8Array(readFileSync(join(GOLD, "03558065-2025-07-26", "filing.pdf")));
    const recordedFirst = JSON.parse(readFileSync(join(FX, "verify", "03558065-first.json"), "utf8")).response;
    const calls: Recorded[] = [];
    const usages: LLMUsage[] = [];
    const cache = new InMemoryCache();
    const reader = provider(readerModel, calls, usages, new Map([["first-read", recordedFirst]]));
    const read = await readScannedAccounts(
      { pdfBytes: bytes, transactionId: "MzUxODk5OTExM2FkaXF6a2N4", companyNumber: number, pageCount: 113 },
      { provider: reader, cache, pageFindingAbovePages: 200 }
    );
    const t0 = Date.now();
    const { table } = await new DebtNoteFacilityReader({ provider: reader, cache }).read({ read, pdfBytes: bytes, accountsType: "group" });
    const t1 = Date.now();
    const gbp = gbpOf(usages);
    spent += gbp;
    printTable(read, table);
    console.log(`  facility read ${((t1 - t0) / 1000).toFixed(1)}s, GBP ${gbp.toFixed(4)}`);
    writeFileSync(
      join(OUT, `${number}.json`),
      JSON.stringify(
        {
          note: "Recorded Anthropic Messages API response for the debt-note facility read (WP-BE16) of a frozen UK gold scan. The first read it rests on is test/fixtures/vision/verify/03558065-first.json. No PDF bytes. Replayed offline by test/capitalStructure.test.ts.",
          companyNumber: number,
          readerModel,
          recordedAt: new Date(t0).toISOString(),
          seconds: { facilityRead: (t1 - t0) / 1000 },
          gbp: Number(gbp.toFixed(4)),
          pagesSent: table.pages,
          calls,
        },
        null,
        1
      )
    );
  }

  // Solid State: everything live, the two second reads side by side.
  if (spent < CAP_GBP) {
    const number = "00771335";
    console.log(`\nSolid State ${number}`);
    const bytes = new Uint8Array(readFileSync(join(GOLD, "00771335-2026-03-31", "filing.pdf")));
    // A recording already made keeps its page-finding, first read and line second read, and its
    // end-to-end times; only the facility read is made again (after a facility prompt change).
    const prevPath = join(OUT, `${number}.json`);
    const prev = existsSync(prevPath) ? JSON.parse(readFileSync(prevPath, "utf8")) : null;
    const kept: Recorded[] = prev ? prev.calls.filter((x: Recorded) => x.stage !== "facility-read" && x.status === 200) : [];
    const replayFrom = kept.length ? new Map<string, unknown>(kept.map((x) => [x.stage, x.response])) : undefined;
    const calls: Recorded[] = [...kept];
    const usages: LLMUsage[] = [];
    const cache = new InMemoryCache();
    const reader = provider(readerModel, calls, usages, replayFrom);
    const finder = provider(finderModel, calls, usages, replayFrom);
    const t0 = Date.now();
    const read = await readScannedAccounts(
      { pdfBytes: bytes, transactionId: "MzUzNTQzMzAzOGFkaXF6a2N4", companyNumber: number, pageCount: 140 },
      { provider: reader, pageFinder: finder, cache }
    );
    const t1 = Date.now();
    let tVerify = 0;
    let tFacilities = 0;
    const [verification, facilities] = await Promise.all([
      new DoubleReadVerifier({ provider: reader, cache })
        .verify({ read, pdfBytes: bytes, pageCount: 140, accountsType: "group" })
        .finally(() => (tVerify = Date.now())),
      new DebtNoteFacilityReader({ provider: reader, cache })
        .read({ read, pdfBytes: bytes, accountsType: "group" })
        .finally(() => (tFacilities = Date.now())),
    ]);
    const t2 = Date.now();
    const gbp = gbpOf(usages);
    spent += gbp;
    const agreed = Object.entries(verification.lines).filter(([, l]) => l.tag === "verified").map(([k]) => k);
    console.log(`  outcome ${read.outcome}; lines agreed: ${agreed.join(", ")}`);
    printTable(read, facilities.table);
    console.log(`  page-find + first read ${((t1 - t0) / 1000).toFixed(1)}s, second read ${((tVerify - t1) / 1000).toFixed(1)}s, facility read ${((tFacilities - t1) / 1000).toFixed(1)}s, total ${((t2 - t0) / 1000).toFixed(1)}s, GBP ${gbp.toFixed(4)}`);
    writeFileSync(
      join(OUT, `${number}.json`),
      JSON.stringify(
        {
          note: "Recorded Anthropic Messages API responses for page-finding, the first read, the line second read and the debt-note facility read (WP-BE16) of a frozen UK gold scan. No PDF bytes. Replayed offline by test/capitalStructure.test.ts.",
          companyNumber: number,
          readerModel,
          finderModel,
          recordedAt: new Date(t0).toISOString(),
          seconds: prev
            ? { ...prev.seconds, facilityRead: (tFacilities - t1) / 1000, endToEndMeasured: prev.recordedAt }
            : { pageFindAndFirstRead: (t1 - t0) / 1000, secondRead: (tVerify - t1) / 1000, facilityRead: (tFacilities - t1) / 1000, total: (t2 - t0) / 1000 },
          gbp: Number(((prev ? prev.gbp : 0) + gbp).toFixed(4)),
          gbpThisRecording: Number(gbp.toFixed(4)),
          usage: usages.map((u) => ({ label: u.label, model: u.model, inputTokens: u.inputTokens, outputTokens: u.outputTokens, seconds: u.durationMs / 1000, gbp: u.costGbp })),
          calls,
        },
        null,
        1
      )
    );
  } else {
    console.log(`STOP before Solid State: GBP ${spent.toFixed(4)} spent`);
  }
  return spent;
}

async function large(spentBefore: number, readerModel: string): Promise<number> {
  let spent = spentBefore;
  for (const c of LARGE_FILINGS) {
    if (spent >= CAP_GBP) {
      console.log(`STOP before ${c.name}: GBP ${spent.toFixed(4)} spent`);
      break;
    }
    const recPath = join(FX, "pages", `${c.number}.json`);
    if (!existsSync(recPath)) continue;
    const rec = JSON.parse(readFileSync(recPath, "utf8"));
    const byStage = new Map<string, unknown>(rec.calls.map((x: any) => [x.stage, x.response]));
    console.log(`\n${c.name} ${c.number}`);
    const bytes = new Uint8Array(readFileSync(join(GOLD, c.folder, "filing.pdf")));
    const calls: Recorded[] = [];
    const usages: LLMUsage[] = [];
    const cache = new InMemoryCache();
    const reader = provider(readerModel, calls, usages, byStage);
    const finder = provider(rec.finderModel, calls, usages, byStage);
    const read = await readScannedAccounts(
      { pdfBytes: bytes, transactionId: c.transactionId, companyNumber: c.number, pageCount: c.pageCount },
      { provider: reader, pageFinder: finder, cache }
    );
    const t0 = Date.now();
    const { table } = await new DebtNoteFacilityReader({ provider: reader, cache }).read({ read, pdfBytes: bytes, accountsType: "group" });
    const t1 = Date.now();
    const gbp = gbpOf(usages);
    spent += gbp;
    printTable(read, table);
    const facilityRead = (t1 - t0) / 1000;
    const composed = rec.seconds.pageFindAndFirstRead + Math.max(rec.seconds.secondRead, facilityRead);
    console.log(`  recorded: page-find + first read ${rec.seconds.pageFindAndFirstRead}s, second read ${rec.seconds.secondRead}s, total ${rec.seconds.total}s`);
    console.log(`  live facility read ${facilityRead.toFixed(1)}s, GBP ${gbp.toFixed(4)}; with it beside the second read: ${composed.toFixed(1)}s`);
    writeFileSync(
      join(OUT, `${c.number}.json`),
      JSON.stringify(
        {
          note: "Recorded Anthropic Messages API response for the debt-note facility read (WP-BE16) of a frozen UK gold scan, made on the first read recorded in test/fixtures/vision/pages. No PDF bytes. Replayed offline by test/capitalStructure.test.ts.",
          companyNumber: c.number,
          readerModel,
          recordedAt: new Date(t0).toISOString(),
          seconds: {
            facilityRead: facilityRead,
            recordedPageFindAndFirstRead: rec.seconds.pageFindAndFirstRead,
            recordedSecondRead: rec.seconds.secondRead,
            recordedTotal: rec.seconds.total,
            composedTotal: Number(composed.toFixed(1)),
          },
          gbp: Number(gbp.toFixed(4)),
          pagesSent: table.pages,
          calls,
        },
        null,
        1
      )
    );
  }
  return spent;
}

async function main() {
  const mode = process.argv[2];
  const config = getLLMConfig();
  if (!config.apiKey || !config.model) throw new Error("no LLM_API_KEY or LLM_MODEL; run with --env-file=.env.local");
  const finderModel = (process.env.PAGE_FINDER_MODEL ?? "").trim() || PAGE_FINDER_MODEL_DEFAULT;
  const before = Number(process.env.ALREADY_SPENT_GBP ?? "0") || 0;
  mkdirSync(OUT, { recursive: true });
  let spent = before;
  if (mode === "gold") spent = await gold(spent, config.model, finderModel);
  else if (mode === "large") spent = await large(spent, config.model);
  else throw new Error("say gold or large");
  console.log(`\nthis run spent GBP ${(spent - before).toFixed(4)}; with ALREADY_SPENT_GBP, GBP ${spent.toFixed(4)} of ${CAP_GBP}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
