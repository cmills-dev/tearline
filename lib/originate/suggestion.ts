// lib/originate/suggestion.ts
// The origination suggestion: a target where BOTH the "why now" (a document-cited catalyst)
// and the "why you" (a provenanced warm-intro path) are individually auditable. A cold
// target (strong catalyst, no path) is surfaced but demoted, never linked by a guess.

import type { Signal } from "./signals";
import type { WarmPath } from "../graph/model";

export interface ScoreBreakdown {
  total: number; // final rank score
  catalyst: number; // "why now" strength (condition + timing)
  fit: number; // mandate-fit multiplier
  pathGate: number; // 1 if a warm path exists, demoted otherwise
}

export interface OriginationSuggestion {
  target: { nodeId: string; name: string; lei?: string; chNumber?: string };
  tier: "warm" | "cold";
  whyNow: Signal[]; // cited catalyst signals (condition + timing)
  fit: Signal[]; // mandate-fit signals
  warmPath: WarmPath | null; // the intro path, hop by hop, or null (cold)
  score: ScoreBreakdown;
  abstentions: string[]; // what could NOT be established for this target
}

export interface OriginationResult {
  suggestions: OriginationSuggestion[]; // ranked, warmest+strongest first
  abstained: { name: string; reason: string }[]; // candidates with no cited catalyst
}
