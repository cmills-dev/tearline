// lib/llm/mockProvider.ts
// A deterministic, in-memory LLMProvider for tests and offline development. It performs
// no network I/O: it simply returns a scripted response string. This lets us exercise
// extract.ts (JSON parsing, code-fence stripping, and the doctrine guard) with no real
// model and no non-determinism.

import type { LLMCompleteOptions, LLMProvider } from "./types";

export class MockProvider implements LLMProvider {
  readonly name = "mock";
  private readonly scripted: string;
  // Records the last options seen, so tests can assert on what the prompt contained.
  public lastOptions: LLMCompleteOptions | null = null;

  constructor(scripted: string) {
    this.scripted = scripted;
  }

  async complete(opts: LLMCompleteOptions): Promise<string> {
    this.lastOptions = opts;
    return this.scripted;
  }
}

// Convenience factory for readability at call sites.
export function mockProvider(scripted: string): MockProvider {
  return new MockProvider(scripted);
}
