// lib/originate/engine.ts
// Engine C - origination of work. Joins the cited "why now" catalyst signals with the
// firm's own "why you" warm-intro path into a ranked, gated OriginationSuggestion. The hard
// gate: a target is surfaced ONLY if it has at least one CITED catalyst signal. A strong
// catalyst with no warm path is surfaced as "cold" (demoted), never linked by a guess. This
// is the USP: a suggestion where both halves are individually auditable to a document.

import type { FactManifest } from "../engine/types";
import type { GraphStore } from "../graph/store";
import { warmestPaths } from "../graph/path";
import { detectSignals, type MandateLike } from "./signals";
import { scoreSuggestion } from "./score";
import type { OriginationResult, OriginationSuggestion } from "./suggestion";

export interface Candidate {
  targetNodeId: string;
  name: string;
  manifest: FactManifest;
  lei?: string;
  chNumber?: string;
}

export interface OriginateInput {
  mandate: MandateLike;
  tenantId: string;
  fromIds: string[]; // the client firm's own node ids (the start of any warm path)
  candidates: Candidate[];
  store: GraphStore;
  includeInference?: boolean;
}

export async function originate(input: OriginateInput): Promise<OriginationResult> {
  const suggestions: OriginationSuggestion[] = [];
  const abstained: { name: string; reason: string }[] = [];

  for (const c of input.candidates) {
    const { signals, abstentions } = detectSignals(c.manifest, input.mandate);
    const whyNow = signals.filter((s) => s.category === "condition" || s.category === "timing");
    const fit = signals.filter((s) => s.category === "fit");

    // Gate: no cited catalyst -> abstain (never surface a target we cannot say why-now for).
    if (whyNow.length === 0) {
      abstained.push({ name: c.name, reason: "no cited catalyst (why-now) established from the record" });
      continue;
    }

    const paths = await warmestPaths(input.store, input.tenantId, input.fromIds, c.targetNodeId, {
      includeInference: input.includeInference,
    });
    const warmPath = paths?.[0] ?? null;
    const score = scoreSuggestion(whyNow, fit, warmPath);

    suggestions.push({
      target: { nodeId: c.targetNodeId, name: c.name, lei: c.lei, chNumber: c.chNumber },
      tier: warmPath ? "warm" : "cold",
      whyNow,
      fit,
      warmPath,
      score,
      abstentions,
    });
  }

  // Rank: warmest + strongest first. A warm target outranks an equal-catalyst cold one via
  // the pathGate already baked into score.total; break ties by catalyst strength.
  suggestions.sort((a, b) => b.score.total - a.score.total || b.score.catalyst - a.score.catalyst);
  return { suggestions, abstained };
}
