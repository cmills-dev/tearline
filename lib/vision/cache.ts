// lib/vision/cache.ts
// The versioned cache for vision reads, on the app's shared cache seam (lib/cache/cache.ts).
//
// Key: vision:v{schema version}:{prompt version}:{first 12 hex of sha256(prompt + schema)}:
//      {model id}:{CH transaction id}:{page set or "all"}
// A change of schema version, prompt text or model is a different key, so it misses. A filing
// transaction id never changes content, so a hit is safe to serve with no model call.

import { createHash } from "node:crypto";
import { getCache, type Cache } from "../cache/cache";
import { VISION_SCHEMA, VISION_SCHEMA_VERSION } from "./schema";
import { PROMPT_VERSION, VISION_PROMPT_FINGERPRINT_TEXT } from "./prompt";
import type { VisionReadResult } from "./types";

export const VISION_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;

export function promptSchemaHash(
  promptText: string = VISION_PROMPT_FINGERPRINT_TEXT,
  schema: Record<string, unknown> = VISION_SCHEMA
): string {
  return createHash("sha256").update(promptText).update(JSON.stringify(schema)).digest("hex").slice(0, 12);
}

export interface VisionKeyParts {
  model: string;
  transactionId: string;
  pageSet?: number[] | "all";
  schemaVersion?: number;
  promptVersion?: string;
  hash?: string;
}

export function pageSetLabel(pageSet: number[] | "all" | undefined): string {
  if (!pageSet || pageSet === "all") return "all";
  return [...pageSet].sort((a, b) => a - b).join(",");
}

export function visionCacheKey(p: VisionKeyParts): string {
  const schemaVersion = p.schemaVersion ?? VISION_SCHEMA_VERSION;
  const promptVersion = p.promptVersion ?? PROMPT_VERSION;
  const hash = p.hash ?? promptSchemaHash();
  return `vision:v${schemaVersion}:${promptVersion}:${hash}:${p.model}:${p.transactionId}:${pageSetLabel(p.pageSet)}`;
}

// The model whose cached reads may be served (WP-BE14). With a provider it is the provider's
// model. With none (no key, LLM_PROVIDER=none, credit switched off) it is the model the
// environment names in LLM_MODEL, so a read already paid for under that model is served with no
// call; before, every no-model path looked under "none", which no paid read is ever stored under,
// and the reads QA04 needed on 27 Sep could not be replayed. With no model named at all there is
// nothing to look under, and "none" is kept. The key format is unchanged, so no version moves.
export function cacheModelFor(provider: { model: string } | null | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (provider) return provider.model;
  return (env.LLM_MODEL ?? "").trim() || "none";
}

export async function getCachedRead(key: string, cache: Cache = getCache()): Promise<VisionReadResult | null> {
  return cache.get<VisionReadResult>(key);
}

export async function setCachedRead(key: string, result: VisionReadResult, cache: Cache = getCache()): Promise<void> {
  await cache.set(key, result, VISION_CACHE_TTL_SECONDS);
}
