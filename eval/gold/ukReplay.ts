// eval/gold/ukReplay.ts
// The recorded first reads (and the recorded model second reads) of the UK gold scans, replayed
// offline. WP-OCR2 needs the same replay eval/gold/uk-verify.ts makes, so it lives here for the
// OCR scripts; uk-verify.ts keeps its own copy until a later package moves it over. No network,
// no model call: every provider here answers from a recording.

import { existsSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { InMemoryCache } from "../../lib/cache/cache";
import { AnthropicProvider } from "../../lib/llm/providers/anthropic";
import { readScannedAccounts } from "../../lib/vision/client";
import type { VisionReadResult } from "../../lib/vision/types";
import type { AccountsTypeLabel } from "../../lib/resolve/accountsType";
import { stageOf } from "../../test/pageFindingCases";
import type { UK_GOLD } from "./uk";

const here = dirname(fileURLToPath(import.meta.url));
export const VISION_FX = join(here, "..", "..", "test", "fixtures", "vision");
export const UK_FIXTURES = join(here, "fixtures", "uk");

// The recorded reads, as eval/gold/uk-verify.ts lists them.
export const RECORDED: Record<string, { first: string; second: string }> = {
  "02662226": { first: "bristol-water-02662226.json", second: "verify/02662226-second.json" },
  "02103564": { first: "matalan-retail-02103564.json", second: "verify/02103564-second.json" },
  "01404552": { first: "verify/01404552-first.json", second: "verify/01404552-second.json" },
  "00769170": { first: "verify/00769170-first.json", second: "verify/00769170-second.json" },
  "03558065": { first: "verify/03558065-first.json", second: "verify/03558065-second.json" },
};
export const PAGED = ["03213782", "00211475", "00445790"];

export function replay(response: unknown, model = "claude-opus-5"): AnthropicProvider {
  return new AnthropicProvider(
    { provider: "anthropic", model, apiKey: "replay", maxTokens: 1024 },
    {
      fetchImpl: async () => new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } }),
      logUsage: () => {},
    }
  );
}

export function replayByStage(byStage: Map<string, unknown>, model: string): AnthropicProvider {
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

const load = (rel: string) => JSON.parse(readFileSync(join(VISION_FX, rel), "utf8"));

export interface ReplayedCase {
  read: VisionReadResult;
  pdfBytes: Uint8Array;
  accountsType: AccountsTypeLabel | null;
  // The provider that answers the model second read from its recording.
  secondReader: AnthropicProvider;
}

export function filingPdf(g: (typeof UK_GOLD)[number]): Uint8Array {
  return new Uint8Array(readFileSync(join(UK_FIXTURES, g.folder, "filing.pdf")));
}

// The first read of a gold scan, replayed; null when nothing was recorded for it.
export async function replayFirstRead(g: (typeof UK_GOLD)[number]): Promise<ReplayedCase | null> {
  const bytes = filingPdf(g);
  const input = { pdfBytes: bytes, transactionId: g.transactionId, companyNumber: g.companyNumber, pageCount: g.pageCount };
  const rec = RECORDED[g.companyNumber];
  if (rec) {
    const read = await readScannedAccounts(input, { provider: replay(load(rec.first).response), cache: new InMemoryCache(), pageFindingAbovePages: 200 });
    return { read, pdfBytes: bytes, accountsType: null, secondReader: replay(load(rec.second).response) };
  }
  const path = join(VISION_FX, "pages", `${g.companyNumber}.json`);
  if (!PAGED.includes(g.companyNumber) || !existsSync(path)) return null;
  const paged = JSON.parse(readFileSync(path, "utf8"));
  if (!paged.calls.length || !paged.calls.every((c: any) => c.status === 200)) return null;
  const byStage = new Map<string, unknown>(paged.calls.map((c: any) => [c.stage, c.response]));
  const reader = replayByStage(byStage, paged.readerModel);
  const read = await readScannedAccounts(input, { provider: reader, pageFinder: replayByStage(byStage, paged.finderModel), cache: new InMemoryCache() });
  return { read, pdfBytes: bytes, accountsType: "group", secondReader: reader };
}
