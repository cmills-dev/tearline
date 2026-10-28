// lib/originate/screenUniverse.ts
// Continuous, universe-wide origination. Where originateForTarget scores ONE Companies House
// number, this runs that same engine across a whole mandate universe and returns a ranked,
// evidence-backed origination list. It abstains honestly: a candidate with no cited catalyst
// (originateForTarget returns null, or a suggestion with an empty whyNow) is DROPPED, never
// surfaced with an invented reason.
//
// Depth choice: we run the FULL per-member origination (originateForTarget), not a lighter
// signals-only pass. The whole point of the ranked list is to pair a document-cited "why now"
// with a provenanced warm-intro path, and only the full path produces both together. To keep
// that affordable and inside the CH rate limit we do two things: (1) enforce a hard `cap` on
// how many members are actually processed, never silently truncating the pool, and (2) lean on
// the shared assertChBudget() guard that every underlying CH call already passes through, plus
// the per-company cache, so a sweep cannot approach CH's 600 / 5 min ceiling. A ChBudgetError
// stops the sweep early and is reported in the note rather than swallowed.

import type { GraphStore } from "../graph/store";
import type { MandateLike } from "./signals";
import type { OriginationSuggestion } from "./suggestion";
import { originateForTarget } from "./live";
import { ChBudgetError } from "../ratelimit/ratelimit";
import type { VisionMode } from "../sources/companiesHouseLive";

// The minimum a candidate needs to be screened. CompanyCandidate (from companiesHouseSearch)
// satisfies this, as does an explicit { chNumber } supplied by an API caller.
export interface ScreenCandidate {
  chNumber: string;
  name?: string;
}

// A screening function for one target. Defaults to originateForTarget; injectable so tests can
// drive screenUniverse with stubbed suggestions and no network.
export type ScreenFn = (
  tenantId: string,
  chNumber: string,
  mandate: MandateLike,
  store: GraphStore,
  fromIds?: string[],
  options?: { vision?: VisionMode },
) => Promise<OriginationSuggestion | null>;

export interface ScreenUniverseOptions {
  cap?: number; // hard limit on how many candidates are actually processed
  screen?: ScreenFn; // injectable screening function (default: originateForTarget)
}

export interface UniverseScreenResult {
  suggestions: OriginationSuggestion[]; // ranked, warmest+strongest first; cited catalyst only
  poolSize: number; // candidates supplied
  processed: number; // candidates actually screened (<= cap)
  surfaced: number; // processed candidates that yielded a cited-catalyst suggestion
  abstained: number; // processed candidates dropped for no cited catalyst
  skipped: number; // pool beyond the cap, deliberately not processed
  cap: number; // the cap applied
  budgetStopped: boolean; // true if the CH budget guard halted the sweep early
  note: string; // one honest line summarising the cap, abstentions and any early stop
}

const DEFAULT_CAP = 12;

// A hard ceiling on how many members ONE request can screen, regardless of the cap it asks
// for. screenUniverse runs a full multi-call origination per member against the SHARED
// Companies House budget, so without a ceiling a single request (a huge chNumbers list or a
// large cap) could drain the whole fleet's 5-minute CH window and starve every other tenant's
// live/monitor/pipeline calls. The overflow is not lost: it is reported as `skipped`, exactly
// like an over-cap pool, so the honesty contract (never silently truncate) still holds.
// Tunable per deployment via PIPELINE_MAX_CAP.
const HARD_MAX_CAP = 50;
function maxCap(): number {
  const fromEnv = Number(process.env.PIPELINE_MAX_CAP);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
  return HARD_MAX_CAP;
}

// A suggestion counts as surfaceable only if it carries at least one cited "why now" signal.
// originateForTarget already enforces this (it returns null with no catalyst), but we re-check
// here so the honesty guarantee holds even against a malformed injected screen function.
function hasCitedCatalyst(s: OriginationSuggestion | null): s is OriginationSuggestion {
  return !!s && Array.isArray(s.whyNow) && s.whyNow.some((sig) => !!sig.source);
}

export async function screenUniverse(
  tenantId: string,
  mandate: MandateLike,
  candidates: ScreenCandidate[],
  store: GraphStore,
  options: ScreenUniverseOptions = {},
): Promise<UniverseScreenResult> {
  // Clamp the requested cap into [1, maxCap()]. The upper bound stops one request from draining
  // the shared CH budget; anything beyond it is reported as `skipped`, never silently dropped.
  const cap = Math.min(maxCap(), Math.max(1, Math.floor(options.cap ?? DEFAULT_CAP)));
  const screen = options.screen ?? originateForTarget;

  // Blank numbers are dropped BEFORE the cap. Kept, each took a place in the cap, was counted as
  // neither processed nor abstained, and pushed a real member into `skipped` (WP-QA03 S4).
  const usable = candidates.filter((c) => (c.chNumber ?? "").trim() !== "");
  const poolSize = usable.length;
  const toProcess = usable.slice(0, cap);
  const skipped = Math.max(0, poolSize - toProcess.length);

  const suggestions: OriginationSuggestion[] = [];
  let processed = 0;
  let abstained = 0;
  let budgetStopped = false;

  for (const candidate of toProcess) {
    const chNumber = candidate.chNumber?.trim();
    if (!chNumber) continue;
    try {
      // Cache-only, always. A screen reads the scans the cache already holds and buys none, so
      // a fifty-member sweep costs nothing at the model (audit BE-18). A member whose filing has
      // never been read simply abstains here and can be read on its own sheet.
      const suggestion = await screen(tenantId, chNumber, mandate, store, undefined, { vision: "cache-only" });
      processed += 1;
      if (hasCitedCatalyst(suggestion)) {
        suggestions.push(suggestion);
      } else {
        abstained += 1; // no cited catalyst -> dropped, never surfaced
      }
    } catch (err) {
      // The CH budget guard fires as a typed error: stop the sweep early and report it rather
      // than pushing past CH's ceiling. Any other per-member failure is treated as an abstain
      // for that one candidate, so a single bad record cannot sink the whole sweep.
      if (err instanceof ChBudgetError) {
        budgetStopped = true;
        break;
      }
      processed += 1;
      abstained += 1;
    }
  }

  // Rank by the transparent total score (catalyst x fit x path gate), warmest+strongest first.
  suggestions.sort((a, b) => b.score.total - a.score.total);

  const note = buildNote({ poolSize, processed, surfaced: suggestions.length, abstained, skipped, cap, budgetStopped });

  return {
    suggestions,
    poolSize,
    processed,
    surfaced: suggestions.length,
    abstained,
    skipped,
    cap,
    budgetStopped,
    note,
  };
}

// Compose one honest, understated summary line. No silent truncation: if the pool exceeded the
// cap we say exactly how many were left unscreened.
function buildNote(r: {
  poolSize: number;
  processed: number;
  surfaced: number;
  abstained: number;
  skipped: number;
  cap: number;
  budgetStopped: boolean;
}): string {
  const parts: string[] = [];
  parts.push(`Screened ${r.processed} of ${r.poolSize} candidates (cap ${r.cap}).`);
  parts.push(`${r.surfaced} surfaced with a cited catalyst.`);
  if (r.abstained > 0) {
    parts.push(`${r.abstained} abstained (no cited catalyst) and were dropped.`);
  }
  if (r.skipped > 0) {
    parts.push(`${r.skipped} candidates exceeded the cap and were not screened.`);
  }
  if (r.budgetStopped) {
    parts.push("The sweep stopped early on the Companies House budget guard; retry shortly for the rest.");
  }
  return parts.join(" ");
}
