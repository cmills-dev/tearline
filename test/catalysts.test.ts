// test/catalysts.test.ts
// The new origination catalysts: maturity/refinancing-window VINTAGE PROXY (item 1) and the
// public distress signals (item 4). Every catalyst is cited to a fact or it abstains, and the
// going-concern text heuristic must NOT fire on the negated wording that appears in healthy
// accounts. In-memory, no network.

import { suite, test, assert, assertEqual } from "./harness";
import { detectSignals } from "../lib/originate/signals";
import { scanGoingConcern } from "../lib/sources/companiesHouseLive";
import type { FactManifest, Fact, Provenance } from "../lib/engine/types";

const prov = (s: string): Provenance => ({
  sourceId: s, tag: "Acc", documentName: s, locator: "http://x", snippet: s, retrievedAt: "2026-01-01", contentHash: "h",
});
const fact = (metric: string, value: number | string, rung: Fact["rung"] = "R1"): Fact => ({
  id: `${metric}.FY2024`, metric, label: metric, period: "FY2024",
  kind: typeof value === "number" ? "currency" : "text",
  value, unit: "GBP", rung, provenance: prov(metric), verification: { status: "SINGLE_SOURCE", checks: [] },
});
const manifest = (facts: Fact[]): FactManifest => ({
  entity: { companyName: "T", companyNumber: "T", jurisdiction: "GB", status: "active", incorporatedOn: "", sicCodes: [], registeredOffice: "", accountsType: "full", latestPeriodEnd: "2024-12-31", synthetic: false },
  facts: Object.fromEntries(facts.map((f) => [f.id, f])), sources: {}, generatedAt: "2026-01-01",
});

const has = (sigs: { type: string }[], t: string) => sigs.some((s) => s.type === t);

suite("originate / catalysts");

export async function registerCatalystsTests(): Promise<void> {
  // A charge created in 2015 is > 5 years old for the life of this project, so the default
  // threshold fires; a 100-year threshold makes the SAME fact fall under, deterministically.
  const agedCharge = manifest([fact("securedVintage.1", "2015-06-01")]);
  const agedFired = detectSignals(agedCharge, {});
  const agedUnder = detectSignals(agedCharge, {}, { maturityVintageYears: 100 });

  test("maturity proxy fires for an old outstanding charge and abstains under a higher threshold", () => {
    assert(has(agedFired.signals, "maturity_window"), "vintage-proxy catalyst fires past the threshold");
    const sig = agedFired.signals.find((s) => s.type === "maturity_window")!;
    assert(!!sig.source, "the catalyst is cited to the charge fact");
    assert(/proxy/i.test(sig.caveat ?? ""), "labelled a proxy, not a maturity date");
    assert(!has(agedUnder.signals, "maturity_window"), "abstains when the charge is under the vintage threshold");
    assert(agedUnder.abstentions.some((a) => /maturity/i.test(a)), "the abstention is recorded");
  });

  test("no securedVintage fact means the maturity proxy abstains, never guesses", () => {
    const r = detectSignals(manifest([fact("turnover", 40e6)]), {});
    assert(!has(r.signals, "maturity_window"), "no maturity signal without a dated outstanding charge");
    assert(r.abstentions.some((a) => /maturity/i.test(a)), "abstention recorded");
  });

  test("an insolvency case on the register is a cited distress catalyst", () => {
    const withCase = detectSignals(manifest([fact("insolvency.administration-order", "administration-order")]), {});
    assert(has(withCase.signals, "insolvency_case"), "insolvency catalyst surfaced");
    assert(withCase.signals.find((s) => s.type === "insolvency_case")!.source !== null, "cited");
    const without = detectSignals(manifest([fact("turnover", 40e6)]), {});
    assert(!has(without.signals, "insolvency_case"), "no insolvency signal when no case is filed");
  });

  test("leverage is a catalyst only when elevated, never on a healthy balance sheet", () => {
    const healthy = detectSignals(manifest([fact("leverage", 0.8, "R2")]), {});
    assert(!has(healthy.signals, "high_leverage"), "0.8x leverage is not a why-now catalyst");
    const moderate = detectSignals(manifest([fact("leverage", 3.5, "R2")]), {});
    const modSig = moderate.signals.find((s) => s.type === "high_leverage");
    assert(!!modSig && modSig.direction === "neutral", "3.5x fires as a neutral, worth-a-look catalyst");
    const elevated = detectSignals(manifest([fact("leverage", 6.0, "R2")]), {});
    const elevSig = elevated.signals.find((s) => s.type === "high_leverage");
    assert(!!elevSig && elevSig.direction === "negative", "6.0x fires as a negative catalyst");
  });

  test("net liabilities and net current liabilities fire only on a negative balance, cited", () => {
    const distressed = detectSignals(manifest([fact("netAssets", -5e6), fact("netCurrentAssets", -2e6)]), {});
    assert(has(distressed.signals, "net_liabilities"), "negative net assets surfaces net liabilities");
    assert(has(distressed.signals, "net_current_liabilities"), "negative net current assets surfaces the deficit");
    const healthy = detectSignals(manifest([fact("netAssets", 5e6), fact("netCurrentAssets", 2e6)]), {});
    assert(!has(healthy.signals, "net_liabilities"), "positive net assets is silent, not a catalyst");
    assert(!has(healthy.signals, "net_current_liabilities"), "positive working capital is silent");
    const absent = detectSignals(manifest([fact("turnover", 40e6)]), {});
    assert(absent.abstentions.some((a) => /net liabilities/i.test(a)), "absence abstains, never assumes solvency");
  });

  test("overdue filings surface only when actually overdue", () => {
    const overdue = detectSignals(manifest([fact("filing.accountsOverdue", "overdue")]), {});
    assert(has(overdue.signals, "accounts_overdue"), "accounts-overdue catalyst surfaced and cited");
    const current = detectSignals(manifest([fact("turnover", 40e6)]), {});
    assert(!has(current.signals, "accounts_overdue"), "no overdue signal when the fact is absent");
  });

  test("going-concern signal fires only when the material-uncertainty fact is present", () => {
    const withGc = detectSignals(manifest([fact("goingConcern.materialUncertainty", "material uncertainty ...", "R3")]), {});
    assert(has(withGc.signals, "going_concern"), "going-concern catalyst surfaced");
    const without = detectSignals(manifest([fact("turnover", 40e6)]), {});
    assert(!has(without.signals, "going_concern"), "no going-concern signal without the fact");
  });

  // The correctness-critical fix: the ISA 570 scanner must reject negated wording.
  test("the going-concern scanner fires on the ISA 570 phrase but NOT on its negation", () => {
    assert(!!scanGoingConcern("... Material Uncertainty Related to Going Concern. We draw attention ..."), "fires on the real ISA 570 section");
    assertEqual(scanGoingConcern("We have not identified a material uncertainty related to going concern."), null, "does not fire on the negated healthy wording");
    assertEqual(scanGoingConcern("There is no material uncertainty relating to going concern in these accounts."), null, "does not fire on 'no material uncertainty'");
    assertEqual(scanGoingConcern("The accounts are prepared on a going concern basis."), null, "a plain going-concern note is not a signal");
    assertEqual(scanGoingConcern(null), null, "no text abstains");
  });
}
