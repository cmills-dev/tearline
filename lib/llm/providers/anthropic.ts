// lib/llm/providers/anthropic.ts
// Anthropic Claude provider, spoken over plain `fetch` with no SDK dependency so it
// works from any runtime (Node, edge, browser-less server) and keeps the parsing
// engine provider-neutral.
//
// The model id comes from LLM_MODEL only. There is no default model in code: with no
// model (or no key) the provider reports itself unconfigured and makes no call.
//
// Hardening, per call:
//   - a timeout through AbortController (30 s for text, 90 s when a document block is sent,
//     both overridable by env, see config.ts);
//   - at most 3 retries on 429, 529 and 5xx (and on a network error), with exponential
//     backoff and full jitter, honouring `retry-after`;
//   - a refusal or a max_tokens stop is a typed failure, never partial text or JSON;
//   - one usage log line: model, tokens (input, output, cache read, cache write), duration
//     and cost in GBP from pricing.ts. Never prompt text, document bytes or the key.
//
// Deliberate omissions: we do NOT send temperature, top_p, top_k, or budget_tokens
// (all are rejected with HTTP 400 on current Claude models). We also do not turn on
// server-side refusal fallbacks: a fallback would change the model that read a filing,
// and the vision cache is keyed on the model id. A refusal is surfaced instead.

import type {
  LLMCallResult,
  LLMCompleteOptions,
  LLMConfig,
  LLMContentBlock,
  LLMFailure,
  LLMRequest,
  LLMUsage,
  StructuredLLMProvider,
} from "../types";
import { LLMCallError } from "../types";
import { costOf } from "../pricing";

const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_BASE_URL = "https://api.anthropic.com";

export const DEFAULT_TEXT_TIMEOUT_MS = 30_000;
export const DEFAULT_VISION_TIMEOUT_MS = 90_000;
export const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;
const RETRY_AFTER_CAP_MS = 60_000;

// Shape of the response we read back. Text lives in `content` blocks of type "text".
interface AnthropicContentBlock {
  type: string;
  text?: string;
}
interface AnthropicUsageBody {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}
interface AnthropicResponse {
  model?: string;
  content?: AnthropicContentBlock[];
  stop_reason?: string | null;
  usage?: AnthropicUsageBody;
}

export type UsageLogger = (usage: LLMUsage) => void;

// Injectable seams so the tests run with no network and no real waiting.
export interface AnthropicDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  logUsage?: UsageLogger;
}

export const defaultUsageLogger: UsageLogger = (u) => {
  // One JSON line per call. Every field here is a count, a name or a cost.
  console.log(`llm.usage ${JSON.stringify(u)}`);
};

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 529 || (status >= 500 && status <= 599);
}

// `retry-after` is seconds or an HTTP date. Returns milliseconds, or null when absent or unreadable.
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  const secs = Number(value.trim());
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, RETRY_AFTER_CAP_MS);
  const at = Date.parse(value);
  if (Number.isFinite(at)) return Math.min(Math.max(at - nowMs, 0), RETRY_AFTER_CAP_MS);
  return null;
}

// Exponential backoff with full jitter: a random wait in [0, min(cap, base * 2^attempt)).
// A `retry-after` from the server is a floor, not a suggestion.
export function backoffMs(attempt: number, random: () => number, retryAfterMs: number | null): number {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
  const jittered = Math.floor(random() * ceiling);
  return retryAfterMs === null ? jittered : Math.max(retryAfterMs, jittered);
}

// output_config.effort is rejected by Haiku 4.5 and the 4.5-and-older Sonnets, so a request that
// asks for an effort on one of them is sent without it rather than failing.
const NO_EFFORT_MODELS = ["claude-haiku-4-5", "claude-sonnet-4-5", "claude-3"];
export function acceptsEffort(model: string): boolean {
  return !NO_EFFORT_MODELS.some((m) => model.startsWith(m));
}

function hasDocument(content: string | LLMContentBlock[]): boolean {
  return Array.isArray(content) && content.some((b) => b.type === "document");
}

export class AnthropicProvider implements StructuredLLMProvider {
  readonly name = "anthropic";
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;
  private readonly visionTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly logUsage: UsageLogger;

  constructor(config: LLMConfig, deps: AnthropicDeps = {}) {
    this.apiKey = config.apiKey ?? "";
    this.model = (config.model ?? "").trim();
    // Trim any trailing slash so `${baseUrl}/v1/messages` is always well-formed.
    this.baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.maxTokens = config.maxTokens;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TEXT_TIMEOUT_MS;
    this.visionTimeoutMs = config.visionTimeoutMs ?? DEFAULT_VISION_TIMEOUT_MS;
    this.fetchImpl = deps.fetchImpl ?? ((...args) => fetch(...args));
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = deps.random ?? Math.random;
    this.now = deps.now ?? Date.now;
    this.logUsage = deps.logUsage ?? defaultUsageLogger;
  }

  // Unconfigured means no call can be made. Reported, not thrown, so callers can abstain.
  get configured(): boolean {
    return this.model.length > 0 && this.apiKey.length > 0;
  }

  // The string path for existing callers. Any failure throws a typed LLMCallError.
  async complete(opts: LLMCompleteOptions): Promise<string> {
    const result = await this.send({ system: opts.system, content: opts.user, maxTokens: opts.maxTokens });
    if (!result.ok) throw new LLMCallError(result.failure);
    return result.text;
  }

  async send(req: LLMRequest): Promise<LLMCallResult> {
    if (!this.model) {
      return { ok: false, failure: { kind: "unconfigured", detail: "LLM_MODEL is not set" }, usage: null };
    }
    if (!this.apiKey) {
      return { ok: false, failure: { kind: "unconfigured", detail: "LLM_API_KEY is not set" }, usage: null };
    }

    const timeoutMs = req.timeoutMs ?? (hasDocument(req.content) ? this.visionTimeoutMs : this.timeoutMs);

    // EXACT request shape required by the Messages API. Do not add sampling params.
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: req.maxTokens ?? this.maxTokens,
      messages: [{ role: "user", content: req.content }],
    };
    if (req.system) body.system = req.system;
    const outputConfig: Record<string, unknown> = {};
    if (req.outputSchema) outputConfig.format = { type: "json_schema", schema: req.outputSchema };
    if (req.effort && acceptsEffort(this.model)) outputConfig.effort = req.effort;
    if (Object.keys(outputConfig).length) body.output_config = outputConfig;
    const payload = JSON.stringify(body);

    const started = this.now();
    let attempts = 0;
    let lastFailure: LLMFailure = { kind: "network", detail: "no attempt made" };

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      attempts = attempt + 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
          method: "POST",
          headers: {
            "x-api-key": this.apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
            "content-type": "application/json",
          },
          body: payload,
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        if (controller.signal.aborted) {
          // A timeout is not retried: a stuck 90 s vision call retried three times is six minutes.
          return { ok: false, failure: { kind: "timeout", detail: `no response within ${timeoutMs} ms` }, usage: null };
        }
        lastFailure = { kind: "network", detail: err instanceof Error ? err.name : "fetch failed" };
        if (attempt < MAX_RETRIES) await this.sleep(backoffMs(attempt, this.random, null));
        continue;
      }

      if (!res.ok) {
        clearTimeout(timer);
        await res.text().catch(() => "");
        if (isRetryableStatus(res.status)) {
          lastFailure = { kind: "retries_exhausted", detail: `HTTP ${res.status} after ${attempts} attempts`, status: res.status };
          if (attempt < MAX_RETRIES) {
            const retryAfter = parseRetryAfter(res.headers.get("retry-after"), this.now());
            await this.sleep(backoffMs(attempt, this.random, retryAfter));
          }
          continue;
        }
        // The error body can echo request content, so only the status is reported.
        return { ok: false, failure: { kind: "http", detail: `HTTP ${res.status}`, status: res.status }, usage: null };
      }

      let data: AnthropicResponse;
      try {
        data = (await res.json()) as AnthropicResponse;
      } catch (err) {
        clearTimeout(timer);
        if (controller.signal.aborted) {
          return { ok: false, failure: { kind: "timeout", detail: `body not read within ${timeoutMs} ms` }, usage: null };
        }
        return { ok: false, failure: { kind: "bad_response", detail: "response body was not JSON" }, usage: null };
      }
      clearTimeout(timer);

      const usage = this.recordUsage(data, this.now() - started, attempts, req.label);

      // A safety refusal is a first-class outcome. Any text before it is discarded.
      if (data.stop_reason === "refusal") {
        return { ok: false, failure: { kind: "refusal", detail: "stop_reason refusal" }, usage };
      }
      // Output cut off at max_tokens is incomplete. Never hand partial JSON to a parser.
      if (data.stop_reason === "max_tokens") {
        return { ok: false, failure: { kind: "max_tokens", detail: "stop_reason max_tokens; output discarded" }, usage };
      }
      if (!Array.isArray(data.content)) {
        return { ok: false, failure: { kind: "bad_response", detail: "no content array" }, usage };
      }

      const text = data.content
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text as string)
        .join("");
      return { ok: true, text, stopReason: data.stop_reason ?? "", usage };
    }

    // Retries used up. Not logged as usage: no response carried token counts.
    return { ok: false, failure: { ...lastFailure, detail: `${lastFailure.detail}; gave up after ${MAX_RETRIES} retries` }, usage: null };
  }

  private recordUsage(data: AnthropicResponse, durationMs: number, attempts: number, label?: string): LLMUsage {
    const u = data.usage ?? {};
    const tokens = {
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    };
    // Price by the model we asked for; the response echoes the same id.
    const cost = costOf(this.model, tokens);
    const usage: LLMUsage = {
      provider: this.name,
      model: this.model,
      ...tokens,
      durationMs,
      attempts,
      costUsd: cost.usd,
      costGbp: cost.gbp,
      priced: cost.priced,
      stopReason: data.stop_reason ?? null,
      ...(label ? { label } : {}),
    };
    this.logUsage(usage);
    return usage;
  }
}
