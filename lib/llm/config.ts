// lib/llm/config.ts
// Reads the parsing-engine configuration from the environment and builds a provider.
// This is the single seam that makes the LLM layer provider-neutral and model-agnostic:
// point the env vars at any endpoint and the rest of the app is unchanged.
//
// Environment variables
// ---------------------------------------------------------------------------
//   LLM_PROVIDER    Which engine to build. One of:
//                     "anthropic"          -> Claude via the Messages API
//                     "openai-compatible"  -> any OpenAI-Chat-Completions endpoint
//                                             (OpenAI, OpenRouter, Groq, Together,
//                                              gateways, or LOCAL: Ollama/LM Studio/vLLM)
//                     "none" (or unset)    -> parsing engine disabled; getProvider()
//                                             returns null and callers must degrade.
//   LLM_MODEL       Model id. Required: there is no default model in code. With no model
//                   the provider is unconfigured and getProvider() returns null. Examples:
//                     anthropic:          claude-opus-5, claude-sonnet-5, claude-haiku-4-5
//                     openai-compatible:  gpt-4o-mini, llama3.1, mistral, etc.
//   LLM_API_KEY     Secret for the endpoint. Optional for keyless local servers.
//   LLM_BASE_URL    Override the endpoint host. Enables gateways and local models,
//                   e.g. http://localhost:11434/v1 is passed as http://localhost:11434
//                   (providers append the version path themselves). See each provider.
//   LLM_MAX_TOKENS  Default completion budget (integer). Defaults to 2048.
//   LLM_TIMEOUT_MS         Timeout for a text call (integer ms). Defaults to 30000.
//   LLM_VISION_TIMEOUT_MS  Timeout for a call carrying a PDF document. Defaults to 90000.
// ---------------------------------------------------------------------------

import type { LLMConfig, LLMProvider, LLMProviderKind } from "./types";
import { AnthropicProvider, DEFAULT_TEXT_TIMEOUT_MS, DEFAULT_VISION_TIMEOUT_MS } from "./providers/anthropic";
import { OpenAICompatibleProvider } from "./providers/openaiCompatible";

const DEFAULT_MAX_TOKENS = 2048;

function readProviderKind(raw: string | undefined): LLMProviderKind {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "anthropic") return "anthropic";
  if (v === "openai-compatible") return "openai-compatible";
  // Everything else, including "none" and unset, disables the engine.
  return "none";
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Resolve configuration from process.env. `env` is injectable for tests.
export function getLLMConfig(env: NodeJS.ProcessEnv = process.env): LLMConfig {
  return {
    provider: readProviderKind(env.LLM_PROVIDER),
    model: (env.LLM_MODEL ?? "").trim(),
    apiKey: env.LLM_API_KEY?.trim() || undefined,
    baseUrl: env.LLM_BASE_URL?.trim() || undefined,
    maxTokens: readPositiveInt(env.LLM_MAX_TOKENS, DEFAULT_MAX_TOKENS),
    timeoutMs: readPositiveInt(env.LLM_TIMEOUT_MS, DEFAULT_TEXT_TIMEOUT_MS),
    visionTimeoutMs: readPositiveInt(env.LLM_VISION_TIMEOUT_MS, DEFAULT_VISION_TIMEOUT_MS),
  };
}

export interface ProviderStatus {
  configured: boolean;
  reason: string; // "ok", or what is missing. Never the key itself.
}

// Whether a provider can be built from this config, and if not, why.
export function providerStatus(config: LLMConfig = getLLMConfig()): ProviderStatus {
  if (config.provider === "none") return { configured: false, reason: "LLM_PROVIDER is unset or none" };
  if (!config.model) return { configured: false, reason: "LLM_MODEL is not set" };
  if (config.provider === "anthropic" && !config.apiKey) return { configured: false, reason: "LLM_API_KEY is not set" };
  return { configured: true, reason: "ok" };
}

// Factory: build the configured provider, or null when the engine is disabled or
// unconfigured. Returning null (rather than throwing) lets the pipeline run without an
// LLM and fall back to purely deterministic extraction.
export function getProvider(config: LLMConfig = getLLMConfig()): LLMProvider | null {
  if (!providerStatus(config).configured) return null;
  switch (config.provider) {
    case "anthropic":
      return new AnthropicProvider(config);
    case "openai-compatible":
      return new OpenAICompatibleProvider(config);
    default:
      return null;
  }
}

// The document-reading provider, or null when the engine is not Anthropic or is unconfigured.
export function getAnthropicProvider(config: LLMConfig = getLLMConfig()): AnthropicProvider | null {
  if (config.provider !== "anthropic" || !providerStatus(config).configured) return null;
  return new AnthropicProvider(config);
}
