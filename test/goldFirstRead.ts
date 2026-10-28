// test/goldFirstRead.ts
// A first read replayed along the path its gold recording took (WP-BE14-LIVE-2).
//
// The unit-test first reads are copies of eval/gold/fixtures/uk/<folder>/reads.json, made by
// scripts/refresh-vision-fixtures.ts. A filing over the whole-read limit was page-found when it was
// recorded, so its first read cites pages of the subset it was sent. Replayed on the whole-document
// path, those page numbers point at the wrong pages. So a page-found recording replays through the
// same page-finding, answered from the gold recording. The first read's answer is the one the caller
// passes, so a test can still change one field of it. No test calls the API.

import { AnthropicProvider } from "../lib/llm/providers/anthropic";
import { InMemoryCache } from "../lib/cache/cache";
import { readScannedAccounts } from "../lib/vision/client";
import type { VisionReadResult } from "../lib/vision/types";
import { loadReads, readerModelOf, finderModelOf } from "../eval/gold/uk-reads";
import { stageOf } from "./pageFindingCases";

export interface FirstReadInput {
  pdfBytes: Uint8Array;
  transactionId: string;
  companyNumber: string;
  pageCount: number;
}

export async function replayGoldFirstRead(input: FirstReadInput, folder: string, firstResponse: unknown): Promise<VisionReadResult> {
  const reads = loadReads(folder);
  const pageFound = !!reads && reads.calls.some((c) => c.stage === "contents");
  const answer = (init?: RequestInit): unknown => {
    const stage = stageOf(JSON.parse(String(init?.body)));
    if (stage === "first-read") return firstResponse;
    const call = reads?.calls.find((c) => c.stage === stage);
    if (!call) throw new Error(`no recorded response for ${stage} in ${folder}`);
    return call.response;
  };
  const provider = (model: string) =>
    new AnthropicProvider(
      { provider: "anthropic", model, apiKey: "replay", maxTokens: 1024 },
      {
        fetchImpl: async (_u: unknown, init?: RequestInit) =>
          new Response(JSON.stringify(answer(init)), { status: 200, headers: { "content-type": "application/json" } }),
        logUsage: () => {},
        sleep: async () => {},
      } as never
    );
  if (!pageFound) {
    // Recorded on the whole document: replay it there, whatever the page-finding limit is today.
    return readScannedAccounts(input, { provider: provider("claude-opus-5"), cache: new InMemoryCache(), pageFindingAbovePages: 200 });
  }
  return readScannedAccounts(input, { provider: provider(readerModelOf(reads!)), pageFinder: provider(finderModelOf(reads!)), cache: new InMemoryCache() });
}
