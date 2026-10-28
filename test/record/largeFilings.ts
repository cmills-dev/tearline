// test/record/largeFilings.ts
// Record the live model reads that test/pageFinding.test.ts replays (WP-BE15). This makes paid
// calls: page-finding (contents and classification passes), the first read of the subset and the
// double read's second read, for the three large group scans in the UK gold set. It is never run
// by `npm test`.
//
// Run from product/, with the key in .env.local:
//   ./node_modules/.bin/tsx --env-file=.env.local test/record/largeFilings.ts            # all three
//   ./node_modules/.bin/tsx --env-file=.env.local test/record/largeFilings.ts 00445790   # one
//
// Each filing writes test/fixtures/vision/pages/<company number>.json: the raw Messages API
// responses (no PDF bytes, no key, no header), which stage each answered, and the wall time and
// cost of each stage. It stops before a filing if the run has already spent GBP 2.40.

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { InMemoryCache } from "../../lib/cache/cache";
import { getLLMConfig } from "../../lib/llm/config";
import { AnthropicProvider } from "../../lib/llm/providers/anthropic";
import type { LLMUsage } from "../../lib/llm/types";
import { readScannedAccounts, type PagedVisionReadResult } from "../../lib/vision/client";
import { DoubleReadVerifier, applyVerification } from "../../lib/vision/verify";
import { visionLines } from "../../lib/sources/visionAccounts";
import { PAGE_FINDER_MODEL_DEFAULT } from "../../lib/vision/pages";
import { stageOf, LARGE_FILINGS } from "../pageFindingCases";

const here = dirname(fileURLToPath(import.meta.url));
const GOLD = join(here, "..", "..", "eval", "gold", "fixtures", "uk");
const OUT = join(here, "..", "fixtures", "vision", "pages");
const RUN_CAP_GBP = 2.4;

interface Recorded {
  stage: string;
  model: string;
  response: unknown;
  status: number;
}

function recordingProvider(model: string, calls: Recorded[], usages: LLMUsage[]): AnthropicProvider {
  const config = { ...getLLMConfig(), model };
  return new AnthropicProvider(config, {
    fetchImpl: async (url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const res = await fetch(url as string, init);
      const text = await res.text();
      let response: unknown = null;
      try {
        response = JSON.parse(text);
      } catch {
        response = null;
      }
      calls.push({ stage: stageOf(body), model, response: res.ok ? response : { error: `HTTP ${res.status}` }, status: res.status });
      return new Response(text, { status: res.status, headers: res.headers });
    },
    logUsage: (u) => {
      usages.push(u);
      console.log(`  usage ${u.label ?? ""} ${u.model} in ${u.inputTokens} out ${u.outputTokens} ${(u.durationMs / 1000).toFixed(1)}s GBP ${u.costGbp?.toFixed(4)}`);
    },
  });
}

async function main() {
  const only = process.argv[2];
  const config = getLLMConfig();
  if (!config.apiKey || !config.model) throw new Error("no LLM_API_KEY or LLM_MODEL; run with --env-file=.env.local");
  const finderModel = (process.env.PAGE_FINDER_MODEL ?? "").trim() || PAGE_FINDER_MODEL_DEFAULT;
  mkdirSync(OUT, { recursive: true });
  let runSpent = 0;

  for (const c of LARGE_FILINGS.filter((x) => !only || x.number === only)) {
    if (runSpent >= RUN_CAP_GBP) {
      console.log(`STOP before ${c.name}: the run has spent GBP ${runSpent.toFixed(4)}`);
      break;
    }
    console.log(`\n${c.name} ${c.number}, ${c.pageCount} pages`);
    const bytes = new Uint8Array(readFileSync(join(GOLD, c.folder, "filing.pdf")));
    const calls: Recorded[] = [];
    const usages: LLMUsage[] = [];
    const reader = recordingProvider(config.model, calls, usages);
    const finder = recordingProvider(finderModel, calls, usages);
    const cache = new InMemoryCache();

    const t0 = Date.now();
    const read = (await readScannedAccounts(
      { pdfBytes: bytes, transactionId: c.transactionId, companyNumber: c.number, pageCount: c.pageCount },
      { provider: reader, pageFinder: finder, cache }
    )) as PagedVisionReadResult;
    const t1 = Date.now();
    // All three are group accounts (their gold meta.json and the register say so), so the basis
    // check runs as it does live (WP-BE18).
    const accountsType = "group" as const;
    const verification = await new DoubleReadVerifier({ provider: reader, cache }).verify({ read, pdfBytes: bytes, pageCount: c.pageCount, accountsType });
    const t2 = Date.now();
    const applied = applyVerification(read, verification);
    const mapped = visionLines(applied.read, applied.tags, c.madeUpDate, { accountsType });

    const gbp = usages.reduce((s, u) => s + (u.costGbp ?? 0), 0);
    runSpent += gbp;
    const pf = read.pageFinding;
    console.log(`  outcome ${read.outcome}; pages sent ${pf?.pages.join(",")}; missing ${pf?.missing.join(",")}; ${read.failure?.detail ?? ""}`);
    console.log(`  page-find + first read ${((t1 - t0) / 1000).toFixed(1)}s, second read ${((t2 - t1) / 1000).toFixed(1)}s, total ${((t2 - t0) / 1000).toFixed(1)}s, GBP ${gbp.toFixed(4)}`);
    for (const f of mapped.figures) console.log(`  SURFACED ${f.key} "${f.line.figureText}" ${f.line.scaleCaption} p${f.line.pdfPageIndex} = ${f.tag.evidence?.pounds}`);
    for (const a of mapped.abstentions) console.log(`  abstain ${a.key}: ${a.reason.slice(0, 140)}`);

    writeFileSync(
      join(OUT, `${c.number}.json`),
      JSON.stringify(
        {
          note: "Recorded Anthropic Messages API responses for page-finding, the first read of the subset and the second read of a frozen UK gold scan (WP-BE15). No PDF bytes. Replayed offline by test/pageFinding.test.ts.",
          companyNumber: c.number,
          transactionId: c.transactionId,
          folder: c.folder,
          pageCount: c.pageCount,
          readerModel: config.model,
          finderModel,
          recordedAt: new Date(t0).toISOString(),
          seconds: { pageFindAndFirstRead: (t1 - t0) / 1000, secondRead: (t2 - t1) / 1000, total: (t2 - t0) / 1000 },
          gbp: Number(gbp.toFixed(4)),
          usage: usages.map((u) => ({ label: u.label, model: u.model, inputTokens: u.inputTokens, outputTokens: u.outputTokens, seconds: u.durationMs / 1000, gbp: u.costGbp })),
          pagesSent: pf?.pages ?? [],
          calls,
        },
        null,
        1
      )
    );
  }
  console.log(`\nrun spent GBP ${runSpent.toFixed(4)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
