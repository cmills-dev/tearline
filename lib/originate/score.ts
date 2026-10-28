// lib/originate/score.ts
// Transparent, decomposable scoring - no black-box ML. Fit is a MULTIPLIER so an off-thesis
// target can never rank highly however strong its catalyst. The path gate demotes a target
// with no warm intro to "cold" rather than suppressing it. Every weight is inspectable.

import type { Signal } from "./signals";
import type { WarmPath } from "../graph/model";
import type { ScoreBreakdown } from "./suggestion";

// Per-type catalyst severity (0..1). Higher = a stronger "why now".
const SEVERITY: Record<string, number> = {
  high_leverage: 0.9,
  thin_cover: 0.7,
  secured_debt: 0.55,
  ownership_change: 0.8,
  maturity_window: 0.85,
};

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export function scoreSuggestion(whyNow: Signal[], fit: Signal[], warmPath: WarmPath | null): ScoreBreakdown {
  // Catalyst: the strongest condition + timing signals, with diminishing returns. A
  // POSITIVE-direction signal is good news, never a "why now", so it never contributes to the
  // catalyst pools even if it reaches whyNow - this stops a healthy metric (e.g. low leverage)
  // being scored as a catalyst. Neutral (worth-a-look) and negative (distress) signals both count.
  const isCatalyst = (s: Signal) => s.direction !== "positive";
  const condition = whyNow.filter((s) => s.category === "condition" && isCatalyst(s)).map((s) => SEVERITY[s.type] ?? 0.4);
  const timing = whyNow.filter((s) => s.category === "timing" && isCatalyst(s)).map((s) => SEVERITY[s.type] ?? 0.4);
  const best = (xs: number[]) => (xs.length ? xs.sort((a, b) => b - a)[0] : 0);
  const secondary = (xs: number[]) => (xs.length > 1 ? xs.sort((a, b) => b - a)[1] * 0.3 : 0);
  const conditionScore = clamp01(best(condition) + secondary(condition));
  const timingScore = clamp01(best(timing) + secondary(timing));
  const catalyst = clamp01(0.6 * conditionScore + 0.4 * timingScore);

  // Fit multiplier: any negative fit collapses the score; positive fit lifts it modestly.
  let fitMult = 1.0;
  for (const s of fit) {
    if (s.direction === "negative") fitMult *= 0.3;
    else if (s.direction === "positive") fitMult *= 1.1;
  }
  fitMult = Math.min(fitMult, 1.3);

  const pathGate = warmPath ? 1.0 : 0.4;
  const total = catalyst * fitMult * pathGate;

  return { total: Number(total.toFixed(4)), catalyst: Number(catalyst.toFixed(4)), fit: Number(fitMult.toFixed(3)), pathGate };
}
