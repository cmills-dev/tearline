// test/screenUniverse.test.ts
// Universe-wide screening: given stubbed suggestions (an injected screening function, so no
// network and no store are exercised), screenUniverse ranks by score, DROPS candidates with no
// cited catalyst (the abstain contract), and reports an honest truncation note when the pool
// exceeds the cap.

import { suite, test, assert, assertEqual } from "./harness";
import { screenUniverse, type ScreenCandidate, type ScreenFn } from "../lib/originate/screenUniverse";
import { ChBudgetError } from "../lib/ratelimit/ratelimit";
import type { GraphStore } from "../lib/graph/store";
import type { OriginationSuggestion } from "../lib/originate/suggestion";
import type { Signal } from "../lib/originate/signals";
import type { Provenance } from "../lib/engine/types";

const T = "tenant-1";

// A cited catalyst signal (carries provenance, so it is a real "why now").
const prov: Provenance = {
  sourceId: "acc", tag: "Acc", documentName: "Annual accounts", locator: "http://x",
  snippet: "leverage 6.0x", retrievedAt: "2026-01-01", contentHash: "h",
};
const citedSignal: Signal = {
  id: "high_leverage.FY2024", type: "high_leverage", category: "condition",
  label: "Leverage", detail: "Net leverage 6.00x", direction: "negative", source: prov, rung: "R2",
};

// A stubbed suggestion with a given total score and a cited catalyst.
function suggestion(name: string, total: number): OriginationSuggestion {
  return {
    target: { nodeId: `co:${name}`, name, chNumber: name },
    tier: "cold",
    whyNow: [citedSignal],
    fit: [],
    warmPath: null,
    score: { total, catalyst: total, fit: 1, pathGate: 0.4 },
    abstentions: [],
  };
}

// The injected screen: maps a CH number to a stubbed outcome. "nocat" abstains (null), exactly
// as originateForTarget returns null when no catalyst is cited.
const outcomes: Record<string, OriginationSuggestion | null> = {
  low: suggestion("low", 0.20),
  high: suggestion("high", 0.90),
  mid: suggestion("mid", 0.55),
  nocat: null,
};
const fakeScreen: ScreenFn = async (_t, chNumber) => outcomes[chNumber] ?? null;

// screenUniverse never touches the store when a screen fn is injected, so a bare object suffices.
const fakeStore = {} as GraphStore;

suite("screenUniverse / universe screening");

export async function registerScreenUniverseTests(): Promise<void> {
  const pool: ScreenCandidate[] = [
    { chNumber: "low" },
    { chNumber: "nocat" },
    { chNumber: "high" },
    { chNumber: "mid" },
  ];
  const ranked = await screenUniverse(T, {}, pool, fakeStore, { cap: 12, screen: fakeScreen });

  test("ranks surfaced suggestions by score, strongest first", () => {
    assertEqual(ranked.suggestions.length, 3, "three cited-catalyst suggestions");
    assertEqual(ranked.suggestions[0].target.name, "high", "highest score first");
    assertEqual(ranked.suggestions[1].target.name, "mid", "then mid");
    assertEqual(ranked.suggestions[2].target.name, "low", "then low");
  });

  test("drops candidates with no cited catalyst (abstain, never surfaced)", () => {
    assert(!ranked.suggestions.some((s) => s.target.name === "nocat"), "nocat not surfaced");
    assertEqual(ranked.abstained, 1, "one abstention counted");
    assert(ranked.note.includes("abstained"), "note records the abstention");
  });

  test("processes the whole pool when it fits under the cap, with no truncation", () => {
    assertEqual(ranked.processed, 4, "all four processed");
    assertEqual(ranked.skipped, 0, "nothing skipped");
  });

  // Same pool, but a cap below the pool size: the excess must be reported, never silently dropped.
  const capped = await screenUniverse(T, {}, pool, fakeStore, { cap: 2, screen: fakeScreen });

  test("enforces the cap and reports how many candidates were left unscreened", () => {
    assertEqual(capped.processed, 2, "only two processed under the cap");
    assertEqual(capped.skipped, 2, "two skipped");
    assert(capped.note.includes("2 candidates exceeded the cap"), "note reports the truncation honestly");
  });

  test("only the two candidates within the cap can appear", () => {
    // The first two of the pool are "low" and "nocat"; nocat abstains, so only "low" surfaces.
    assertEqual(capped.suggestions.length, 1, "one surfaced within the cap");
    assertEqual(capped.suggestions[0].target.name, "low", "the first in-cap cited candidate");
  });

  // A request asking for an enormous cap must be clamped to the hard ceiling, so one caller
  // cannot drain the shared Companies House budget. A 200-strong pool with cap 100000 may
  // process at most HARD_MAX_CAP (50); the rest are reported as skipped, never silently dropped.
  const bigPool: ScreenCandidate[] = Array.from({ length: 200 }, (_, i) => ({ chNumber: `nocat` , name: `c${i}` }));
  const clamped = await screenUniverse(T, {}, bigPool, fakeStore, { cap: 100_000, screen: fakeScreen });

  test("clamps an over-large requested cap to the hard ceiling", () => {
    assertEqual(clamped.cap, 50, "cap clamped to HARD_MAX_CAP");
    assert(clamped.processed <= 50, "never processes more than the hard ceiling");
    assertEqual(clamped.processed, 50, "processes exactly the ceiling from a larger pool");
  });

  test("reports the over-ceiling remainder as skipped, never silently dropped", () => {
    assertEqual(clamped.skipped, 150, "200 pool minus the 50 processed are reported skipped");
    assert(clamped.note.includes("150 candidates exceeded the cap"), "the note reports the truncation honestly");
  });

  // A CH budget exhaustion (a typed ChBudgetError propagated up from live.ts, no longer swallowed)
  // must stop the sweep early and be reported honestly, not counted as a per-candidate abstention.
  const budgetScreen: ScreenFn = async (_t, chNumber) => {
    if (chNumber === "boom") throw new ChBudgetError(120);
    return outcomes[chNumber] ?? null;
  };
  const budgetPool: ScreenCandidate[] = [
    { chNumber: "high" },
    { chNumber: "boom" },
    { chNumber: "mid" },
  ];
  const budgetRun = await screenUniverse(T, {}, budgetPool, fakeStore, { cap: 12, screen: budgetScreen });

  test("stops the sweep early on a CH budget error and reports it, never as an abstention", () => {
    assert(budgetRun.budgetStopped, "the budget guard halted the sweep");
    assertEqual(budgetRun.processed, 1, "only the candidate before the budget error was processed");
    assertEqual(budgetRun.surfaced, 1, "the one processed candidate surfaced");
    assertEqual(budgetRun.abstained, 0, "budget exhaustion is not counted as an abstention");
    assert(budgetRun.note.includes("budget guard"), "the note reports the early stop honestly");
  });

  // Audit BE-18. A universe sweep runs the same engine per member, so once a paid vision step is
  // on the live path a sweep would buy one read per member. The screen must therefore ask for
  // cache-only, and this records that it does.
  const modes: (string | undefined)[] = [];
  const modeScreen: ScreenFn = async (_t, chNumber, _m, _s, _from, options) => {
    modes.push(options?.vision);
    return outcomes[chNumber] ?? null;
  };
  const modePool: ScreenCandidate[] = [{ chNumber: "high" }, { chNumber: "mid" }, { chNumber: "low" }];
  await screenUniverse(T, {}, modePool, fakeStore, { cap: 12, screen: modeScreen });

  test("a screen reads cached vision reads only, so a sweep buys nothing", () => {
    assertEqual(modes.length, 3, "every member was screened");
    assert(modes.every((m) => m === "cache-only"), `every member asked for cache-only: ${modes.join(",")}`);
  });
}
