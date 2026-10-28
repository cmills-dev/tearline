// lib/kb/knownUnknowns.ts
// Known-unknowns / coverage-gap report (Module 2, #3): the honest supportability surface for a
// master entity. For EACH credit concept a desk might want (lib/clientspec/concepts.CONCEPTS),
// either we hold a LIVE fact (supported) or we do not, and where we do not, WHY and what would
// close the gap. This is pure over the store's coverage() view: it never invents support, and a
// gap ALWAYS carries a reason, so the report is a trustworthy known-unknowns map, not a wish list.
//
// The canonical gap is UK filleted accounts, which carry no profit and loss account, so the P&L
// lines (turnover, gross profit, operating profit, EBITDA) are unsupportable from Companies House
// alone and need full statutory accounts or an entitled source (e.g. Octus).

import type { KbStore, KnownUnknowns, KnownUnknownItem, KbCoverageItem } from "./kbTypes";
import type { Rung } from "../engine/types";
import { CONCEPTS } from "../clientspec/concepts";

// The profit-and-loss lines a UK filleted filing simply does not carry.
const PROFIT_AND_LOSS_KEYS = new Set(["turnover", "grossProfit", "operatingProfit", "ebitda"]);

// Rung precedence: R1 (reported) is the best, R4 the weakest. "Best" is the lowest number.
function betterRung(a: Rung, b: Rung): Rung {
  return a <= b ? a : b;
}

export async function knownUnknowns(
  store: KbStore,
  masterId: string,
  ctx?: { accountsType?: string }
): Promise<KnownUnknowns> {
  const cov = await store.coverage(masterId);
  const entity = await store.getEntity(masterId);

  // Group live coverage items by metric: a concept.key may be carried across several periods, so
  // we union sources and keep the best rung across every period that holds it.
  const byMetric = new Map<string, KbCoverageItem[]>();
  for (const item of cov.items) {
    const list = byMetric.get(item.metric);
    if (list) list.push(item);
    else byMetric.set(item.metric, [item]);
  }

  const filleted = ctx?.accountsType === "filleted";

  const items: KnownUnknownItem[] = CONCEPTS.map((concept) => {
    const held = byMetric.get(concept.key);

    if (held && held.length > 0) {
      // SUPPORTED: a live fact is actually held. Union sources across periods, pick the best rung.
      const sources: string[] = [];
      let rung = held[0].rung;
      for (const it of held) {
        rung = betterRung(rung, it.rung);
        for (const s of it.sources) if (!sources.includes(s)) sources.push(s);
      }
      return { concept: concept.key, supported: true, rung, sources };
    }

    // GAP: no live fact. It must carry a reason and what would close it. NEVER mark it supported.
    if (filleted && PROFIT_AND_LOSS_KEYS.has(concept.key)) {
      return {
        concept: concept.key,
        supported: false,
        sources: [],
        gapReason: "UK filleted accounts carry no profit and loss account",
        closesWith: "full statutory accounts or an entitled source (e.g. Octus)",
      };
    }

    return {
      concept: concept.key,
      supported: false,
      sources: [],
      gapReason: "not reported by any held source",
      closesWith: "a source that reports this concept, or a client-supplied figure",
    };
  });

  const supportedCount = items.filter((i) => i.supported).length;
  const gapCount = items.length - supportedCount;

  return {
    masterId,
    entityName: entity?.names[0] ?? "",
    supportedCount,
    gapCount,
    items,
  };
}
