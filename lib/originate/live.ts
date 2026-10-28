// lib/originate/live.ts
// Engine C on REAL data. Given a target Companies House number and the tenant's graph (their
// onboarded relationships), it: (1) ingests the target's own network from filings so shared
// counterparties become shared nodes; (2) builds the target's tear-sheet manifest; (3)
// computes the cited "why now" catalyst signals; (4) finds the warmest intro path from the
// client firm to the target. A warm path appears exactly when the firm already knows a
// counterparty the target's filings name (a lender, an owner) - the moment the two graphs meet.

import type { GraphStore } from "../graph/store";
import { buildLiveFactManifest, type VisionMode } from "../sources/companiesHouseLive";
import { ingestCompanyNetwork } from "../graph/ingest/companiesHouse";
import { warmestPaths } from "../graph/path";
import { detectSignals, type MandateLike } from "./signals";
import { scoreSuggestion } from "./score";
import { CLIENT_FIRM_NODE } from "../onboarding/tools";
import { ChBudgetError } from "../ratelimit/ratelimit";
import type { OriginationSuggestion } from "./suggestion";

// A CH-budget exhaustion must NOT be swallowed as an ordinary abstention: it means "we ran out
// of the shared Companies House budget before we could screen this target", not "this target has
// no catalyst". Re-throwing it lets screenUniverse stop the sweep early and the API report a
// 429/retry, instead of silently mislabelling budget exhaustion as a clean abstain.
function rethrowBudget(e: unknown): null {
  if (e instanceof ChBudgetError) throw e;
  return null;
}

export async function originateForTarget(
  tenantId: string,
  chNumber: string,
  mandate: MandateLike,
  store: GraphStore,
  fromIds: string[] = [CLIENT_FIRM_NODE],
  options: { vision?: VisionMode } = {},
): Promise<OriginationSuggestion | null> {
  // Build the target's neighbourhood so its lenders/owners are shared nodes the firm may know.
  await ingestCompanyNetwork(tenantId, chNumber, store).catch(rethrowBudget);

  // One target, asked for by name, may pay for a scan to be read. A universe sweep may not, and
  // passes "cache-only" (audit BE-18).
  const manifest = await buildLiveFactManifest(chNumber, { vision: options.vision ?? "auto" }).catch(rethrowBudget);
  if (!manifest) return null;

  const { signals, abstentions } = detectSignals(manifest, mandate);
  const whyNow = signals.filter((s) => s.category === "condition" || s.category === "timing");
  const fit = signals.filter((s) => s.category === "fit");
  if (whyNow.length === 0) return null; // no cited catalyst -> abstain, never surface

  const paths = await warmestPaths(store, tenantId, fromIds, `co:${chNumber}`);
  const warmPath = paths?.[0] ?? null;
  const score = scoreSuggestion(whyNow, fit, warmPath);

  return {
    target: { nodeId: `co:${chNumber}`, name: manifest.entity.companyName, lei: manifest.entity.lei, chNumber },
    tier: warmPath ? "warm" : "cold",
    whyNow,
    fit,
    warmPath,
    score,
    abstentions,
  };
}
