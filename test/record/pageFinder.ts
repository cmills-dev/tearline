// test/record/pageFinder.ts
// Record the page finder's own calls (contents and classification passes, no read) on one saved
// filing, for test/pageFinding.test.ts to replay (WP-BE21). This makes paid calls to the page
// finder's model only, about GBP 0.07 on a 116-page scan. It is never run by `npm test`.
//
// Run from product/, with the key in .env.local:
//   ./node_modules/.bin/tsx --env-file=.env.local test/record/pageFinder.ts <filing.pdf> <company number> [out.json]
//
// Writes the raw Messages API responses (no PDF bytes, no key, no header), the stage each
// answered and the finding the finder made from them. The default output is
// test/fixtures/vision/pages/<company number>-finder.json.

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { getLLMConfig } from "../../lib/llm/config";
import { AnthropicProvider } from "../../lib/llm/providers/anthropic";
import { PAGE_FINDER_MODEL_DEFAULT, findPages, openPdf } from "../../lib/vision/pages";
import { stageOf } from "../pageFindingCases";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", "fixtures", "vision", "pages");

async function main() {
  const [pdfPath, companyNumber, outArg] = process.argv.slice(2);
  if (!pdfPath || !companyNumber) throw new Error("usage: pageFinder.ts <filing.pdf> <company number> [out.json]");
  const config = getLLMConfig();
  if (!config.apiKey) throw new Error("no LLM_API_KEY; run with --env-file=.env.local");
  const model = (process.env.PAGE_FINDER_MODEL ?? "").trim() || PAGE_FINDER_MODEL_DEFAULT;
  const calls: { stage: string; model: string; response: unknown; status: number }[] = [];
  const finder = new AnthropicProvider(
    { ...config, model },
    {
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
      logUsage: (u) => console.log(`  usage ${u.label ?? ""} ${u.model} in ${u.inputTokens} out ${u.outputTokens} GBP ${u.costGbp?.toFixed(4)}`),
    }
  );
  const doc = await openPdf(new Uint8Array(readFileSync(pdfPath)));
  if (!doc) throw new Error("the PDF did not open");
  const outcome = await findPages({ doc, transactionId: "record", companyNumber, readerModel: config.model || "claude-opus-5" }, { finder });
  const finding = outcome.ok
    ? { pages: outcome.finding.pages, byRole: outcome.finding.byRole, range: outcome.finding.range, contents: outcome.finding.contents, classified: outcome.finding.classified }
    : { failed: outcome.reason, detail: outcome.detail };
  console.log(JSON.stringify(outcome.ok ? { pages: outcome.finding.pages, byRole: outcome.finding.byRole, range: outcome.finding.range, offset: outcome.finding.contents.offset } : finding, null, 1));
  mkdirSync(OUT, { recursive: true });
  const out = outArg || join(OUT, `${companyNumber}-finder.json`);
  writeFileSync(out, JSON.stringify({ companyNumber, recordedAt: new Date().toISOString(), finderModel: model, calls, finding }, null, 1) + "\n");
  console.log(`wrote ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
