// lib/llm/pricing.ts
// The one price table for model calls, and the cost arithmetic every usage log line uses.
//
// Source: Anthropic first-party API list prices as given in the claude-api skill model table
// (cached 2026-06-24), read on Tue 15 Sep 2026. Prices are USD per million tokens.
// Cache reads bill at 0.1x the input price (0.025x on Claude Fable 5.1, which is $0.25/MTok).
// Cache writes bill at 1.25x the input price for the default 5-minute TTL.
// Update this table and PRICES_SOURCE_DATE together. Nothing else in the code holds a price.

export const PRICES_SOURCE_DATE = "2026-06-24";

// A planning rate, not a live quote. Set on 15 Sep 2026. It errs towards a higher GBP figure,
// which is the safe direction for a spend cap.
export const USD_TO_GBP = 0.8;

export interface ModelPrice {
  inputPerMTok: number; // USD
  outputPerMTok: number; // USD
  cacheReadPerMTok: number; // USD
  cacheWritePerMTok: number; // USD, 5-minute TTL
}

function price(input: number, output: number, cacheReadMultiplier = 0.1): ModelPrice {
  return {
    inputPerMTok: input,
    outputPerMTok: output,
    cacheReadPerMTok: input * cacheReadMultiplier,
    cacheWritePerMTok: input * 1.25,
  };
}

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-fable-5-1": price(10, 50, 0.025),
  "claude-fable-5": price(10, 50),
  "claude-opus-5": price(5, 25),
  "claude-opus-4-8": price(5, 25),
  "claude-opus-4-7": price(5, 25),
  "claude-opus-4-6": price(5, 25),
  "claude-sonnet-5": price(2, 10),
  "claude-sonnet-4-6": price(3, 15),
  "claude-haiku-4-5": price(1, 5),
};

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface CallCost {
  usd: number | null; // null when the model is not in the table
  gbp: number | null;
  priced: boolean;
}

// Cost of one call. An unknown model is reported as unpriced, never as zero.
export function costOf(model: string, t: TokenCounts): CallCost {
  const p = MODEL_PRICES[model];
  if (!p) return { usd: null, gbp: null, priced: false };
  const usd =
    (t.inputTokens * p.inputPerMTok +
      t.outputTokens * p.outputPerMTok +
      t.cacheReadTokens * p.cacheReadPerMTok +
      t.cacheWriteTokens * p.cacheWritePerMTok) /
    1_000_000;
  return { usd, gbp: usd * USD_TO_GBP, priced: true };
}
