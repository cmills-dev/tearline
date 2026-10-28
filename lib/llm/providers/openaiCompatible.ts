// lib/llm/providers/openaiCompatible.ts
// The "any model" provider. Speaks the OpenAI Chat Completions wire format over plain
// `fetch`, which is the de-facto lingua franca for LLM endpoints. By setting
// LLM_BASE_URL this single provider covers:
//
//   - OpenAI            (default, https://api.openai.com)
//   - OpenRouter        (https://openrouter.ai/api)
//   - Groq              (https://api.groq.com/openai)
//   - Together          (https://api.together.xyz)
//   - Azure-compatible / any gateway exposing /v1/chat/completions
//   - LOCAL models:
//       Ollama          (http://localhost:11434/v1)
//       LM Studio       (http://localhost:1234/v1)
//       vLLM            (http://localhost:8000/v1)
//
// That configurability is exactly what "keep it open to any model" means: no code
// change is needed to swap engines, only environment.

import type { LLMCompleteOptions, LLMConfig, LLMMessage, LLMProvider } from "../types";
import { LLMCallError } from "../types";

const DEFAULT_BASE_URL = "https://api.openai.com";

interface OpenAIChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly name = "openai-compatible";
  private readonly model: string;
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly maxTokens: number;

  constructor(config: LLMConfig) {
    // Note: local models (Ollama etc.) often need no key, so apiKey is optional here.
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.maxTokens = config.maxTokens;

    if (!this.model) {
      throw new Error("OpenAICompatibleProvider: LLM_MODEL is required for the openai-compatible provider.");
    }
  }

  async complete(opts: LLMCompleteOptions): Promise<string> {
    const maxTokens = opts.maxTokens ?? this.maxTokens;

    // This wire format has no PDF document block. Text blocks are joined; a document is refused.
    let user: string;
    if (typeof opts.user === "string") {
      user = opts.user;
    } else {
      if (opts.user.some((b) => b.type === "document")) {
        throw new LLMCallError({ kind: "unsupported_content", detail: "openai-compatible provider cannot send a document block" });
      }
      user = opts.user.map((b) => (b.type === "text" ? b.text : "")).join("\n");
    }

    const messages: LLMMessage[] = [];
    if (opts.system) messages.push({ role: "system", content: opts.system });
    messages.push({ role: "user", content: user });

    const headers: Record<string, string> = { "content-type": "application/json" };
    // Only attach auth when a key is present, so keyless local servers still work.
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.model,
        max_tokens: maxTokens,
        messages,
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `OpenAICompatibleProvider: request failed with HTTP ${res.status} ${res.statusText}. ${detail}`
      );
    }

    const data = (await res.json()) as OpenAIChatResponse;
    return data.choices?.[0]?.message?.content ?? "";
  }
}
