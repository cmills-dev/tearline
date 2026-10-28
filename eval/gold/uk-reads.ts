// eval/gold/uk-reads.ts
// The recorded model reads the UK eval gate replays (WP-BE13), one file per gold case:
// eval/gold/fixtures/uk/<folder>/reads.json. Each file holds the raw Messages API responses of
// every model call one run of the real path made on that filing (page-finding, the first read,
// the second read, the debt-note read), keyed by stage, plus how each was recorded.
//
// Replay serves a stage's recorded response to the real AnthropicProvider through its fetchImpl,
// so the whole engine runs unchanged and nothing leaves the machine. A call the current code
// makes that has no recording, or whose request differs from the one recorded, is logged: the
// gate then says the recording is stale instead of scoring an answer to a different question.
//
// requestSha256 is the sha256 of the request body the current code sent when the read was
// recorded. Reads recorded before WP-BE13 (copied from test/fixtures/vision/) carry null: they
// replay, but nothing proves the request is still the same one.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AnthropicProvider } from "../../lib/llm/providers/anthropic";
import { getLLMConfig } from "../../lib/llm/config";
import { costOf } from "../../lib/llm/pricing";
import { stageOf } from "../../test/pageFindingCases";
import { PROMPT_VERSION } from "../../lib/vision/prompt";
import { VISION_SCHEMA_VERSION } from "../../lib/vision/schema";
import { SECOND_READ_PROMPT_VERSION, SECOND_READ_SCHEMA_VERSION } from "../../lib/vision/secondRead";
import { FACILITY_READ_PROMPT_VERSION, FACILITY_READ_SCHEMA_VERSION } from "../../lib/vision/capitalStructure";
import { PAGE_FINDER_VERSION } from "../../lib/vision/pages";

const here = dirname(fileURLToPath(import.meta.url));
export const UK_FIXTURES = join(here, "fixtures", "uk");

export interface RecordedCall {
  stage: string; // "contents", "classify:<a>-<b>", "first-read", "second-read", "facility-read"
  model: string;
  requestSha256: string | null; // null: recorded before WP-BE13, request not fingerprinted
  version: string | null; // prompt and schema version of the stage when recorded (versionOf); null if unknown
  recordedAt: string; // ISO time of the live call
  gbp: number | null; // what the call cost, from its usage and lib/llm/pricing.ts
  source: string; // where the response came from: "eval:uk:live", or the repo path it was copied from
  response: unknown; // the raw Messages API response body
}

export interface CaseReads {
  note: string;
  companyNumber: string;
  transactionId: string;
  // How the run that made these reads was configured. The gate replays with production settings,
  // so a recording made another way shows up as stale rather than being scored.
  recordedWith: { accountsType: string | null; pageFindingAbovePages: number | null; by: string };
  calls: RecordedCall[];
}

export const readsPath = (folder: string) => join(UK_FIXTURES, folder, "reads.json");

export function loadReads(folder: string): CaseReads | null {
  const p = readsPath(folder);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as CaseReads) : null;
}

export function saveReads(folder: string, reads: CaseReads): void {
  writeFileSync(readsPath(folder), JSON.stringify(reads, null, 1) + "\n");
}

export function requestSha256(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

// The prompt and schema version a stage runs under in the current code. These are the versions
// the production caches key on, so a recording under another version answers a question the
// current code no longer asks.
export function versionOf(stage: string): string {
  if (stage === "first-read") return `${PROMPT_VERSION}/schema ${VISION_SCHEMA_VERSION}`;
  if (stage === "second-read") return `${SECOND_READ_PROMPT_VERSION}/schema ${SECOND_READ_SCHEMA_VERSION}`;
  if (stage === "facility-read") return `${FACILITY_READ_PROMPT_VERSION}/schema ${FACILITY_READ_SCHEMA_VERSION}`;
  return PAGE_FINDER_VERSION; // contents and classify
}

export const readerModelOf = (r: CaseReads) => r.calls.find((c) => c.stage === "first-read")?.model ?? "claude-opus-5";
export const finderModelOf = (r: CaseReads) => r.calls.find((c) => c.stage === "contents" || c.stage.startsWith("classify:"))?.model ?? "claude-haiku-4-5";

// What one replayed run asked for and got.
export interface ReplayLog {
  served: { stage: string; fingerprint: "same" | "different" | "not-recorded"; version: "current" | "old" | "unknown"; recordedVersion: string | null }[];
  missing: string[]; // stages the current code called that have no recording
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

// A provider config as production builds it (lib/llm/config.ts), for one model, with no key.
function configFor(model: string, apiKey = "replay") {
  return getLLMConfig({ LLM_PROVIDER: "anthropic", LLM_MODEL: model, LLM_API_KEY: apiKey } as unknown as NodeJS.ProcessEnv);
}

// Reader and finder providers that answer from the recording. Nothing is fetched.
export function replayProviders(reads: CaseReads, log: ReplayLog): { reader: AnthropicProvider; finder: AnthropicProvider } {
  const used = new Map<string, number>();
  const fetchImpl = async (_url: unknown, init?: RequestInit) => {
    const body = String(init?.body ?? "");
    const stage = stageOf(JSON.parse(body));
    const matching = reads.calls.filter((c) => c.stage === stage);
    const n = used.get(stage) ?? 0;
    const call = matching[Math.min(n, matching.length - 1)];
    used.set(stage, n + 1);
    if (!call) {
      log.missing.push(stage);
      throw new Error(`no recorded response for ${stage}`);
    }
    const fingerprint = call.requestSha256 === null ? "not-recorded" : call.requestSha256 === requestSha256(body) ? "same" : "different";
    const version = call.version === null ? "unknown" : call.version === versionOf(stage) ? "current" : "old";
    log.served.push({ stage, fingerprint, version, recordedVersion: call.version });
    return json(call.response);
  };
  const deps = { fetchImpl: fetchImpl as typeof fetch, logUsage: () => {}, sleep: async () => {} };
  return {
    reader: new AnthropicProvider(configFor(readerModelOf(reads)), deps),
    finder: new AnthropicProvider(configFor(finderModelOf(reads)), deps),
  };
}

// Reader and finder providers that call the live API and keep every 200 response. Before each call
// it checks the spend so far against the cap and refuses the call if the cap is reached.
export interface Recorder {
  reader: AnthropicProvider;
  finder: AnthropicProvider;
  calls: RecordedCall[];
  failures: { stage: string; status: number; body: string }[]; // non-200 answers, kept for the report
  spentGbp: () => number;
}

// `reuse` holds recorded calls to serve instead of calling, for stages the caller has shown are
// still current; they are kept in the new recording as they were, with no spend.
export function recordingProviders(opts: { apiKey: string; readerModel: string; finderModel: string; capGbp: number; alreadySpentGbp: () => number; reuse?: RecordedCall[] }): Recorder {
  const calls: RecordedCall[] = [];
  const failures: Recorder["failures"] = [];
  let fresh = 0; // spend on calls this recorder made; a reused call cost nothing now
  const spent = () => fresh;
  const fetchImpl = async (url: unknown, init?: RequestInit) => {
    const body = String(init?.body ?? "");
    const parsed = JSON.parse(body);
    const reused = opts.reuse?.find((c) => c.stage === stageOf(parsed));
    if (reused) {
      calls.push(reused);
      return json(reused.response);
    }
    if (opts.alreadySpentGbp() + spent() >= opts.capGbp) throw new Error(`the GBP ${opts.capGbp} cap is reached; no further call is made`);
    const res = await fetch(url as string, init);
    const text = await res.text();
    if (res.status === 200) {
      const response = JSON.parse(text);
      const u = response.usage ?? {};
      const cost = costOf(parsed.model, {
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      });
      if (cost.gbp !== null) fresh += cost.gbp;
      calls.push({
        stage: stageOf(parsed),
        model: parsed.model,
        requestSha256: requestSha256(body),
        version: versionOf(stageOf(parsed)),
        recordedAt: new Date().toISOString(),
        gbp: cost.gbp === null ? null : Math.round(cost.gbp * 10_000) / 10_000,
        source: "eval:uk:live",
        response,
      });
    }
    else failures.push({ stage: stageOf(parsed), status: res.status, body: text.slice(0, 300) });
    return new Response(text, { status: res.status, headers: res.headers });
  };
  const deps = { fetchImpl: fetchImpl as typeof fetch };
  return {
    reader: new AnthropicProvider(configFor(opts.readerModel, opts.apiKey), deps),
    finder: new AnthropicProvider(configFor(opts.finderModel, opts.apiKey), deps),
    calls,
    failures,
    spentGbp: spent,
  };
}
