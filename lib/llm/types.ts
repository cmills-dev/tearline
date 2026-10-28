// lib/llm/types.ts
// Provider-neutral, model-agnostic contract for the parsing engine.
//
// The whole point of this layer: the parsing engine is pluggable. Any model
// reachable over HTTP can be wired in through configuration alone (see config.ts)
// without changing calling code. We deliberately depend on nothing but `fetch`,
// so an Anthropic endpoint, an OpenAI-compatible endpoint, a gateway, or a local
// model (Ollama, LM Studio, vLLM) all satisfy the same interface.

// A single chat message in the neutral shape every provider maps onto its own wire
// format. `system` is separated out at call time by providers that expect it as a
// dedicated field (Anthropic), or folded into the messages array (OpenAI-compatible).
export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// Content blocks for a user turn. A document block carries a whole PDF as base64. Only
// providers that read documents accept it (Anthropic); the others refuse it by name.
export interface LLMTextBlock {
  type: "text";
  text: string;
}
export interface LLMDocumentBlock {
  type: "document";
  source: { type: "base64"; media_type: "application/pdf"; data: string };
  title?: string;
}
export type LLMContentBlock = LLMTextBlock | LLMDocumentBlock;

// Options for a single completion. Kept minimal and deterministic on purpose:
// no temperature / sampling knobs are exposed here, because parsing must be
// reproducible and because some current models reject those parameters outright.
// `user` is a plain string for the existing callers, or content blocks.
export interface LLMCompleteOptions {
  system?: string;
  user: string | LLMContentBlock[];
  maxTokens?: number;
}

// The one interface the rest of the app talks to. Implementations live under
// providers/ (anthropic, openaiCompatible) plus a deterministic mockProvider for
// tests. `complete` returns the model's raw text response; parsing of that text
// into structured extractions is the caller's job (see extract.ts). A failed call
// (refusal, max_tokens, timeout, exhausted retries) throws an LLMCallError.
export interface LLMProvider {
  readonly name: string;
  complete(opts: LLMCompleteOptions): Promise<string>;
}

// Which concrete provider to build. "none" (and unset) means the parsing engine is
// disabled and getProvider() returns null; callers must degrade gracefully.
export type LLMProviderKind = "anthropic" | "openai-compatible" | "none";

// Fully-resolved configuration, produced by getLLMConfig() from environment.
export interface LLMConfig {
  provider: LLMProviderKind;
  model: string; // from LLM_MODEL only; empty means unconfigured
  apiKey?: string;
  baseUrl?: string;
  maxTokens: number;
  timeoutMs?: number; // text calls, LLM_TIMEOUT_MS, default 30 s
  visionTimeoutMs?: number; // calls carrying a document block, LLM_VISION_TIMEOUT_MS, default 90 s
}

// ---------------------------------------------------------------------------
// Typed call results (the hardened path)
// ---------------------------------------------------------------------------

// One usage record per model call. Never carries prompt text, document bytes or keys.
export interface LLMUsage {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  durationMs: number;
  attempts: number;
  costUsd: number | null; // null when the model is not in the price table
  costGbp: number | null;
  priced: boolean;
  stopReason: string | null;
  label?: string; // caller's tag, e.g. "vision:02662226"
}

export type LLMFailureKind =
  | "unconfigured" // no model id or no key
  | "refusal" // stop_reason refusal
  | "max_tokens" // stop_reason max_tokens: the output is incomplete and is discarded
  | "timeout" // the AbortController fired
  | "retries_exhausted" // 429, 529 or 5xx still failing after the last retry
  | "http" // a non-retryable HTTP status (4xx other than 429)
  | "network" // fetch itself threw, after retries
  | "bad_response" // the body was not the expected JSON shape
  | "unsupported_content"; // e.g. a document block sent to a text-only provider

export interface LLMFailure {
  kind: LLMFailureKind;
  detail: string; // short, safe to log: status codes and reasons, never prompt text
  status?: number;
}

export type LLMCallResult =
  | { ok: true; text: string; stopReason: string; usage: LLMUsage }
  | { ok: false; failure: LLMFailure; usage: LLMUsage | null };

export type LLMEffort = "low" | "medium" | "high" | "xhigh" | "max";

// A request on the hardened path. `outputSchema` asks for structured output (JSON schema).
export interface LLMRequest {
  system?: string;
  content: string | LLMContentBlock[];
  maxTokens?: number;
  outputSchema?: Record<string, unknown>;
  // How hard the model thinks (output_config.effort). Left out, the model's default ("high" on
  // Opus 5). Dropped for models that do not accept it (Haiku 4.5, Sonnet 4.5 and older).
  effort?: LLMEffort;
  timeoutMs?: number; // per-call override of the config timeout
  label?: string;
}

// A provider that returns typed results rather than throwing. The vision client needs this.
export interface StructuredLLMProvider extends LLMProvider {
  readonly model: string;
  send(req: LLMRequest): Promise<LLMCallResult>;
}

export class LLMCallError extends Error {
  readonly kind: LLMFailureKind;
  readonly status?: number;
  constructor(failure: LLMFailure) {
    super(`LLM call failed (${failure.kind}): ${failure.detail}`);
    this.name = "LLMCallError";
    this.kind = failure.kind;
    this.status = failure.status;
  }
}
