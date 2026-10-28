// test/llmProvider.test.ts
// The hardened Anthropic provider: timeout, retries on 429, 529 and 5xx with retry-after,
// give-up after 3 retries, refusal and max_tokens as typed failures, the model id from env
// only, usage logging and the cost arithmetic. Every call goes through a mocked fetch.

import { suite, test, assert, assertEqual } from "./harness";
import { getLLMConfig, getProvider, providerStatus } from "../lib/llm/config";
import * as anthropicModule from "../lib/llm/providers/anthropic";
import { AnthropicProvider, backoffMs, parseRetryAfter, MAX_RETRIES } from "../lib/llm/providers/anthropic";
import { OpenAICompatibleProvider } from "../lib/llm/providers/openaiCompatible";
import { costOf, USD_TO_GBP, MODEL_PRICES } from "../lib/llm/pricing";
import { LLMCallError, type LLMConfig, type LLMUsage } from "../lib/llm/types";

const KEY = "test-key-not-real";

function cfg(over: Partial<LLMConfig> = {}): LLMConfig {
  return { provider: "anthropic", model: "claude-opus-5", apiKey: KEY, maxTokens: 1024, timeoutMs: 1000, visionTimeoutMs: 1000, ...over };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function okBody(text: string, stop = "end_turn", usage = { input_tokens: 100, output_tokens: 20 }) {
  return { model: "claude-opus-5", content: [{ type: "text", text }], stop_reason: stop, usage };
}

interface Harness {
  provider: AnthropicProvider;
  calls: RequestInit[];
  sleeps: number[];
  usage: LLMUsage[];
}

// A provider over a scripted sequence of responses. No real waiting between retries.
function scripted(responses: Array<() => Response | Promise<Response>>, over: Partial<LLMConfig> = {}): Harness {
  const calls: RequestInit[] = [];
  const sleeps: number[] = [];
  const usage: LLMUsage[] = [];
  let i = 0;
  const provider = new AnthropicProvider(cfg(over), {
    fetchImpl: async (_url, init) => {
      calls.push(init ?? {});
      const next = responses[Math.min(i++, responses.length - 1)];
      return next();
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0,
    logUsage: (u) => usage.push(u),
  });
  return { provider, calls, sleeps, usage };
}

// A fetch that never answers until its signal aborts, as a stuck upstream would.
function hangingFetch(): typeof fetch {
  return (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
}

const PDF_BLOCK = { type: "document" as const, source: { type: "base64" as const, media_type: "application/pdf" as const, data: "JVBERi0=" } };

suite("llm/provider timeout");

test("a text call that never answers fails as timeout after LLM_TIMEOUT_MS", async () => {
  const provider = new AnthropicProvider(cfg({ timeoutMs: 20 }), { fetchImpl: hangingFetch(), logUsage: () => {} });
  const r = await provider.send({ content: "hello" });
  assert(!r.ok, "a hung call must fail");
  if (!r.ok) assertEqual(r.failure.kind, "timeout", "failure kind is timeout");
});

test("a call carrying a document uses the vision timeout, not the text timeout", async () => {
  const provider = new AnthropicProvider(cfg({ timeoutMs: 5, visionTimeoutMs: 2000 }), {
    fetchImpl: () => new Promise((res) => setTimeout(() => res(jsonResponse(200, okBody("{}"))), 40)),
    logUsage: () => {},
  });
  const r = await provider.send({ content: [PDF_BLOCK, { type: "text", text: "read" }] });
  assert(r.ok, "a 40 ms vision call must survive a 5 ms text timeout");
});

test("a timed-out call is not retried", async () => {
  let calls = 0;
  const provider = new AnthropicProvider(cfg({ timeoutMs: 10 }), {
    fetchImpl: (u, i) => {
      calls++;
      return hangingFetch()(u, i);
    },
    sleep: async () => {},
    logUsage: () => {},
  });
  await provider.send({ content: "hello" });
  assertEqual(calls, 1, "one attempt only");
});

test("timeouts default to 30 s text and 90 s vision, and env overrides both", () => {
  const d = getLLMConfig({} as NodeJS.ProcessEnv);
  assertEqual(d.timeoutMs, 30_000, "text default");
  assertEqual(d.visionTimeoutMs, 90_000, "vision default");
  const o = getLLMConfig({ LLM_TIMEOUT_MS: "1234", LLM_VISION_TIMEOUT_MS: "5678" } as unknown as NodeJS.ProcessEnv);
  assertEqual(o.timeoutMs, 1234, "text override");
  assertEqual(o.visionTimeoutMs, 5678, "vision override");
});

suite("llm/provider retries");

test("retries once on 429 and then succeeds", async () => {
  const h = scripted([() => jsonResponse(429, { type: "error" }), () => jsonResponse(200, okBody("done"))]);
  const r = await h.provider.send({ content: "x" });
  assert(r.ok, "second attempt succeeds");
  assertEqual(h.calls.length, 2, "two fetches");
  if (r.ok) assertEqual(r.usage.attempts, 2, "usage records two attempts");
});

test("retries on 529 overloaded", async () => {
  const h = scripted([() => jsonResponse(529, { type: "error" }), () => jsonResponse(529, {}), () => jsonResponse(200, okBody("done"))]);
  const r = await h.provider.send({ content: "x" });
  assert(r.ok, "third attempt succeeds");
  assertEqual(h.calls.length, 3, "three fetches");
});

test("retries on 503 and honours retry-after", async () => {
  const h = scripted([() => jsonResponse(503, {}, { "retry-after": "2" }), () => jsonResponse(200, okBody("done"))]);
  const r = await h.provider.send({ content: "x" });
  assert(r.ok, "succeeds after the wait");
  assertEqual(h.sleeps.length, 1, "one wait");
  assertEqual(h.sleeps[0], 2000, "waited the 2 s retry-after (jitter is 0 here)");
});

test("gives up after 3 retries on a persistent 500", async () => {
  const h = scripted([() => jsonResponse(500, {})]);
  const r = await h.provider.send({ content: "x" });
  assert(!r.ok, "must fail");
  if (!r.ok) {
    assertEqual(r.failure.kind, "retries_exhausted", "kind");
    assertEqual(r.failure.status, 500, "last status");
  }
  assertEqual(h.calls.length, MAX_RETRIES + 1, "one attempt plus 3 retries");
  assertEqual(h.sleeps.length, MAX_RETRIES, "a wait before each retry, none after the last");
  assertEqual(MAX_RETRIES, 3, "the retry cap is 3");
});

test("a 400 is not retried", async () => {
  const h = scripted([() => jsonResponse(400, { type: "error" })]);
  const r = await h.provider.send({ content: "x" });
  assertEqual(h.calls.length, 1, "one fetch");
  if (!r.ok) assertEqual(r.failure.kind, "http", "kind http");
});

test("a network error is retried and then reported", async () => {
  const h = scripted([
    () => {
      throw new TypeError("fetch failed");
    },
  ]);
  const r = await h.provider.send({ content: "x" });
  assertEqual(h.calls.length, MAX_RETRIES + 1, "retried");
  if (!r.ok) assertEqual(r.failure.kind, "network", "kind network");
});

test("backoff grows exponentially, stays under the ceiling, and treats retry-after as a floor", () => {
  assert(backoffMs(0, () => 0.999, null) < 1000, "attempt 0 under 1 s");
  assert(backoffMs(2, () => 0.999, null) < 4000, "attempt 2 under 4 s");
  assert(backoffMs(2, () => 0.999, null) >= 3900, "attempt 2 near its ceiling at high jitter");
  assertEqual(backoffMs(1, () => 0, 5000), 5000, "retry-after is the floor");
  assertEqual(parseRetryAfter("3", 0), 3000, "seconds form");
  assertEqual(parseRetryAfter(new Date(10_000).toUTCString(), 4_000), 6000, "HTTP date form");
  assertEqual(parseRetryAfter(null, 0), null, "absent");
});

suite("llm/provider stop reasons");

test("a refusal is a typed failure and no text is returned", async () => {
  const h = scripted([() => jsonResponse(200, okBody("partial", "refusal"))]);
  const r = await h.provider.send({ content: "x" });
  assert(!r.ok, "refusal is not ok");
  if (!r.ok) {
    assertEqual(r.failure.kind, "refusal", "kind refusal");
    assert(r.usage !== null, "a refusal still logs usage");
  }
  assert(!("text" in r), "no text on the failure");
});

test("a max_tokens stop is a typed failure, never partial JSON", async () => {
  const h = scripted([() => jsonResponse(200, okBody('{"lines": {"turnover": ', "max_tokens"))]);
  const r = await h.provider.send({ content: "x", outputSchema: { type: "object" } });
  assert(!r.ok, "max_tokens is not ok");
  if (!r.ok) assertEqual(r.failure.kind, "max_tokens", "kind max_tokens");
});

test("complete() throws an LLMCallError for max_tokens and refusal", async () => {
  for (const stop of ["max_tokens", "refusal"]) {
    const h = scripted([() => jsonResponse(200, okBody("{", stop))]);
    let caught: unknown = null;
    try {
      await h.provider.complete({ user: "x" });
    } catch (e) {
      caught = e;
    }
    assert(caught instanceof LLMCallError, `${stop} throws LLMCallError`);
    assertEqual((caught as LLMCallError).kind, stop, "error kind matches the stop reason");
  }
});

test("complete() still returns text for a string prompt", async () => {
  const h = scripted([() => jsonResponse(200, okBody("hello back"))]);
  assertEqual(await h.provider.complete({ user: "hello", system: "s" }), "hello back", "string path works");
  const body = JSON.parse(String(h.calls[0].body));
  assertEqual(body.messages[0].content, "hello", "string content sent as a string");
  assertEqual(body.system, "s", "system sent");
});

suite("llm/provider model and content");

test("the model id comes from LLM_MODEL only; there is no default model", () => {
  const env = { LLM_PROVIDER: "anthropic", LLM_API_KEY: KEY } as unknown as NodeJS.ProcessEnv;
  const config = getLLMConfig(env);
  assertEqual(config.model, "", "no model in config");
  assertEqual(getProvider(config), null, "no provider without a model");
  assertEqual(providerStatus(config).reason, "LLM_MODEL is not set", "status says why");
  assert(!("ANTHROPIC_DEFAULT_MODEL" in anthropicModule), "the hard-coded default is gone");
  const withModel = getLLMConfig({ ...env, LLM_MODEL: "claude-sonnet-5" } as NodeJS.ProcessEnv);
  assertEqual(providerStatus(withModel).configured, true, "configured with a model");
});

test("an unconfigured provider makes no call and reports unconfigured", async () => {
  const h = scripted([() => jsonResponse(200, okBody("x"))], { model: "" });
  const r = await h.provider.send({ content: "x" });
  assertEqual(h.calls.length, 0, "no fetch");
  if (!r.ok) assertEqual(r.failure.kind, "unconfigured", "kind unconfigured");
  assertEqual(h.provider.configured, false, "configured is false");
});

test("the request carries the env model, document blocks and structured output", async () => {
  const h = scripted([() => jsonResponse(200, okBody("{}"))], { model: "claude-sonnet-5" });
  await h.provider.send({ content: [PDF_BLOCK, { type: "text", text: "read" }], outputSchema: { type: "object" } });
  const body = JSON.parse(String(h.calls[0].body));
  assertEqual(body.model, "claude-sonnet-5", "model from config");
  assertEqual(body.messages[0].content[0].type, "document", "document block first");
  assertEqual(body.output_config.format.type, "json_schema", "structured output requested");
  assert(!("temperature" in body), "no sampling parameters");
});

test("the openai-compatible provider refuses a document block by name", async () => {
  const p = new OpenAICompatibleProvider({ provider: "openai-compatible", model: "m", maxTokens: 10 });
  let caught: unknown = null;
  try {
    await p.complete({ user: [PDF_BLOCK] });
  } catch (e) {
    caught = e;
  }
  assert(caught instanceof LLMCallError, "throws LLMCallError");
  assertEqual((caught as LLMCallError).kind, "unsupported_content", "kind unsupported_content");
});

suite("llm/usage and cost");

test("each call logs model, tokens, duration and GBP cost, and nothing from the prompt", async () => {
  const usageBody = { input_tokens: 44_828, output_tokens: 884, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const h = scripted([() => jsonResponse(200, okBody("{}", "end_turn", usageBody))]);
  await h.provider.send({ system: "SECRET-SYSTEM-TEXT", content: [PDF_BLOCK, { type: "text", text: "SECRET-USER-TEXT" }], label: "vision:test" });
  assertEqual(h.usage.length, 1, "one usage record");
  const u = h.usage[0];
  assertEqual(u.model, "claude-opus-5", "model");
  assertEqual(u.inputTokens, 44_828, "input tokens");
  assertEqual(u.outputTokens, 884, "output tokens");
  assertEqual(u.cacheReadTokens, 0, "cache read");
  assertEqual(u.cacheWriteTokens, 0, "cache write");
  assert(typeof u.durationMs === "number" && u.durationMs >= 0, "duration");
  assert(u.costGbp !== null && Math.abs(u.costGbp - 0.24624 * USD_TO_GBP) < 1e-9, "GBP cost from the table");
  const line = JSON.stringify(u);
  for (const secret of ["SECRET-SYSTEM-TEXT", "SECRET-USER-TEXT", "JVBERi0", KEY]) {
    assert(!line.includes(secret), `usage line must not carry ${secret}`);
  }
});

test("cost arithmetic: input, output, cache read and cache write", () => {
  const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  assertEqual(costOf("claude-opus-5", { ...zero, inputTokens: 1_000_000 }).usd, 5, "1M input on Opus 5 is $5");
  assertEqual(costOf("claude-opus-5", { ...zero, outputTokens: 1_000_000 }).usd, 25, "1M output on Opus 5 is $25");
  assertEqual(costOf("claude-opus-5", { ...zero, cacheReadTokens: 1_000_000 }).usd, 0.5, "cache read at 0.1x");
  assertEqual(costOf("claude-opus-5", { ...zero, cacheWriteTokens: 1_000_000 }).usd, 6.25, "cache write at 1.25x");
  assertEqual(costOf("claude-fable-5-1", { ...zero, cacheReadTokens: 1_000_000 }).usd, 0.25, "Fable 5.1 cache read is $0.25");
  const c = costOf("claude-opus-5", { ...zero, inputTokens: 1_000_000, outputTokens: 1_000_000 });
  assertEqual(c.gbp, 30 * USD_TO_GBP, "GBP is USD times the one rate");
  const unknown = costOf("some-future-model", { ...zero, inputTokens: 5 });
  assertEqual(unknown.priced, false, "an unknown model is unpriced");
  assertEqual(unknown.gbp, null, "and never costed as zero");
  assert(Object.keys(MODEL_PRICES).length > 0, "one price table");
});
