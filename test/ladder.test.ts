// test/ladder.test.ts
import { buildManifest } from "../lib/engine/buildManifest";
import { assembleTearSheet } from "../lib/engine/assemble";
import { meridian } from "../lib/sources/fixtures/meridian";
import { redacta } from "../lib/sources/fixtures/redacta";
import { buildNarrative, renderTemplate } from "../lib/engine/languagePlane";
import { suite, test, assert, assertEqual, assertThrows } from "./harness";

suite("ladder / MERIDIAN (data-rich)");

const mm = buildManifest(meridian);

test("EBITDA synthesised at R2 from EBIT + D&A", () => {
  const f = mm.facts["ebitda.FY2024"];
  assertEqual(f.rung, "R2", "rung");
  assertEqual(f.value, 8_700_000, "6.4m EBIT + 2.3m D&A");
  assert(!!f.derivation, "has a declared derivation");
});

test("net debt synthesised at R2 (borrowings - cash)", () => {
  const f = mm.facts["netDebt.FY2024"];
  assertEqual(f.rung, "R2", "rung");
  assertEqual(f.value, 18_100_000, "22.0m - 3.9m");
});

test("leverage synthesised at R2 (net debt / EBITDA)", () => {
  const f = mm.facts["leverage.FY2024"];
  assertEqual(f.rung, "R2", "rung");
  assertEqual(f.value, 2.08, "18.1 / 8.7");
});

test("balance sheet identity passes and upgrades verification", () => {
  const f = mm.facts["totalAssets.FY2024"];
  assertEqual(f.verification.status, "STRUCTURAL_PASS", "assets=liab+equity holds");
});

test("reported facts carry a content hash on provenance", () => {
  const f = mm.facts["turnover.FY2024"];
  assertEqual(f.rung, "R1", "reported");
  assert(!!f.provenance && f.provenance.contentHash.startsWith("fnv1a:"), "hashed");
});

suite("ladder / REDACTA (filleted)");

const rr = buildManifest(redacta);

test("turnover abstains at R4 (not filed under filleted exemption)", () => {
  const f = rr.facts["turnover.FY2024"];
  assertEqual(f.rung, "R4", "abstain");
  assertEqual(f.value, null, "no value invented");
  assert(!!f.attemptLog && f.attemptLog.length > 0, "attempt log retained");
});

test("EBITDA falls to an R3 proxy (EBIT stands in) with bias flag", () => {
  const f = rr.facts["ebitda.FY2024"];
  assertEqual(f.rung, "R3", "proxy");
  assertEqual(f.value, 340_000, "EBIT used as proxy");
  assert(!!f.proxy, "has proxy metadata");
  assertEqual(f.proxy!.biasDirection, "understates", "EBIT understates EBITDA");
});

test("net debt still resolves at R2 from the balance sheet", () => {
  const f = rr.facts["netDebt.FY2024"];
  assertEqual(f.rung, "R2", "rung");
  assertEqual(f.value, 940_000, "1.15m - 0.21m");
});

test("leverage resolves at R2 but flags inherited proxy bias", () => {
  const f = rr.facts["leverage.FY2024"];
  assertEqual(f.rung, "R2", "rung");
  assert(!!f.derivation?.note && f.derivation.note.includes("proxy"), "bias note present");
});

test("interest cover abstains at R4 (no net interest disclosed)", () => {
  const f = rr.facts["interestCover.FY2024"];
  assertEqual(f.rung, "R4", "abstain");
});

suite("assemble + language plane");

test("assembled tear sheets produce ProseGate-clean narrative for both borrowers", () => {
  for (const ts of [assembleTearSheet(mm, meridian), assembleTearSheet(rr, redacta)]) {
    assert(ts.narrative.length > 0, "narrative not empty");
    // renderTemplate already asserts clean; also check tiles and evidence exist.
    assert(Object.keys(ts.evidence).length > 0, "evidence cards built");
    assert(ts.tiles.length > 0, "figure tiles built");
  }
});

test("language plane rejects a template that originates a bare number", () => {
  assertThrows(
    () => renderTemplate("Turnover is 48200000 in the period.", mm, "test.badnumber"),
    "bare digit must be rejected"
  );
});

test("language plane renders values only via fact tokens", () => {
  const out = renderTemplate(
    "Turnover is {{value:turnover.FY2024}} ({{rung:turnover.FY2024}}).",
    mm,
    "test.token"
  );
  assert(out.includes("48.2m"), "value substituted from fact");
  assert(out.includes("reported"), "rung substituted from fact");
});

test("an abstaining total assets figure writes no balance sentence and does not break the sheet", () => {
  // WP-BE10: a scan whose balance sheet prints no total assets line left totalAssets at R4, the
  // narrative rendered its value as a dash, and ProseGate refused the whole tear sheet.
  const m = structuredClone(mm);
  const period = Object.values(m.facts).find((x) => x.metric === "netDebt")!.period;
  m.facts[`totalAssets.${period}`] = {
    id: `totalAssets.${period}`,
    metric: "totalAssets",
    label: "Total assets",
    period,
    kind: "currency",
    value: null,
    unit: "GBP",
    rung: "R4",
    provenance: null,
    verification: { status: "NOT_APPLICABLE", checks: [] },
    attemptLog: [{ step: "R1 reported", outcome: "missing", detail: "not-printed" }],
  };
  const paras = buildNarrative(m);
  assert(!paras.some((p) => /Total assets|total assets/.test(p)), "no sentence about an abstained total");
  assert(!paras.some((p) => p.includes("\u2014")), "no dash in the prose");
});

suite("ladder / leases (WP-BE23)");

import { resolveDerivedMetrics, DERIVED_WITH_BORROWINGS_SPLIT } from "../lib/engine/buildManifest";

// Meridian's FY2024 facts with a printed lease split added, as the vision path lands them.
function withLeases(lines: Record<string, number>): Record<string, import("../lib/engine/types").Fact> {
  const facts = Object.fromEntries(
    Object.entries(mm.facts).filter(([, f]) => f.period === "FY2024" && f.rung === "R1").map(([k, f]) => [k, { ...f }])
  );
  const cash = facts["cash.FY2024"];
  for (const [metric, value] of Object.entries(lines)) facts[`${metric}.FY2024`] = { ...cash, id: `${metric}.FY2024`, metric, label: metric, value };
  resolveDerivedMetrics(facts, "FY2024", DERIVED_WITH_BORROWINGS_SPLIT);
  return facts;
}

test("a printed split with no total derives the total at R2, and says it is not printed", () => {
  const f = withLeases({ leaseLiabilitiesCurrent: 1_000_000, leaseLiabilitiesNonCurrent: 4_000_000 })["leaseLiabilitiesTotal.FY2024"];
  assertEqual(f.rung, "R2", "derived, not printed");
  assertEqual(f.value, 5_000_000, "1.0m + 4.0m");
  assert(!!f.derivation?.note?.includes("not printed"), "the derivation says the total is not printed");
});

test("net debt is printed twice, and leverage divides net debt including leases by EBITDA", () => {
  const facts = withLeases({ leaseLiabilitiesTotal: 5_000_000 });
  assertEqual(facts["netDebtIncludingLeases.FY2024"].value, 23_100_000, "22.0m + 5.0m - 3.9m");
  assertEqual(facts["netDebt.FY2024"].value, 18_100_000, "22.0m - 3.9m, excluding leases");
  assertEqual(facts["netDebt.FY2024"].label, "Net debt excluding leases", "named for what it is");
  assertEqual(facts["leverage.FY2024"].value, 2.66, "23.1 / 8.7, not 18.1 / 8.7");
  assert(facts["leverage.FY2024"].derivation!.formula.includes("including leases"), "the pairing is stated");
});

test("a source that asked for leases and has no lease total abstains on leverage rather than pairing unlike figures", () => {
  const facts = withLeases({});
  assertEqual(facts["leverage.FY2024"].rung, "R4", "abstains");
  assertEqual(facts["netDebt.FY2024"].value, 18_100_000, "net debt excluding leases still prints");
});

test("a source that reads no lease line keeps net debt excluding leases, and says so", () => {
  const f = mm.facts["leverage.FY2024"];
  assert(f.derivation!.formula.includes("excluding leases"), "formula names the net debt");
  assert(!!f.derivation!.note?.includes("No lease liability is on this sheet"), "the note says leases are in neither figure");
});

// WP-BE23 rebased: the merge onto the build branch, and the consumers that arrived after BE23.
import { runEnrichedChecks } from "../lib/kb/check";

test("EBITDA at or below zero still abstains on leverage when net debt includes leases (QA03 N3 kept)", () => {
  const facts = withLeases({ leaseLiabilitiesTotal: 5_000_000 });
  const base = Object.fromEntries(Object.entries(facts).filter(([, f]) => f.rung === "R1"));
  base["depreciationAmortisation.FY2024"] = { ...base["depreciationAmortisation.FY2024"], value: -7_000_000 };
  resolveDerivedMetrics(base, "FY2024", DERIVED_WITH_BORROWINGS_SPLIT);
  assertEqual(base["leverage.FY2024"].rung, "R4", "a loss-making EBITDA gives no multiple");
});

test("a lease split in two units derives no total", () => {
  const facts = withLeases({});
  const cur = { ...facts["cash.FY2024"], id: "leaseLiabilitiesCurrent.FY2024", metric: "leaseLiabilitiesCurrent", value: 1_000_000 };
  const non = { ...cur, id: "leaseLiabilitiesNonCurrent.FY2024", metric: "leaseLiabilitiesNonCurrent", value: 4_000_000, unit: "USD" };
  const base = Object.fromEntries(Object.entries(facts).filter(([, f]) => f.rung === "R1"));
  base[cur.id] = cur;
  base[non.id] = non;
  resolveDerivedMetrics(base, "FY2024", DERIVED_WITH_BORROWINGS_SPLIT);
  assert(base["leaseLiabilitiesTotal.FY2024"]?.value == null, "no total across a currency change");
});

test("the leverage reconciliation checks the net debt the ladder paired, so a lease-paired leverage is not a contradiction", () => {
  const facts = withLeases({ leaseLiabilitiesTotal: 5_000_000 });
  const checks = runEnrichedChecks(facts, "FY2024");
  const lev = checks.find((c) => c.id === "leverage.FY2024");
  assert(!!lev, "the leverage check ran");
  assert(lev!.passed, `leverage reconciles on net debt including leases: ${lev!.detail}`);
  assert(lev!.identity.includes("including leases"), "the identity names the net debt it used");
  const incl = checks.find((c) => c.id === "net-debt-including-leases.FY2024");
  assert(!!incl && incl.passed, "net debt including leases reconciles to borrowings + leases - cash");
});

test("the narrative names the net debt the leverage was built on", () => {
  const facts = withLeases({ leaseLiabilitiesTotal: 5_000_000 });
  const paras = buildNarrative({ ...mm, facts });
  const p = paras.find((x) => x.includes("putting leverage at"));
  assert(!!p, "the leverage sentence is written");
  assert(p!.startsWith("Net debt including leases stands at") && p!.includes("23.1m") && p!.includes("2.66"), p!);
  const plain = buildNarrative(mm).find((x) => x.includes("putting leverage at"));
  assert(!!plain && plain.startsWith("Net debt stands at") && plain.includes("18.1m"), plain ?? "no sentence");
});

test("the tear sheet shows net debt including leases before net debt excluding leases", () => {
  const facts = withLeases({ leaseLiabilitiesTotal: 5_000_000 });
  const ts = assembleTearSheet({ ...mm, facts }, meridian);
  const order = ts.tiles.map((t) => t.factId);
  const i = order.indexOf("netDebtIncludingLeases.FY2024");
  const e = order.indexOf("netDebt.FY2024");
  assert(i >= 0 && e > i, `tiles lead with net debt including leases: ${order.join(", ")}`);
  const rows = ts.financials.rows.map((r) => r.metric);
  assert(rows.indexOf("netDebtIncludingLeases") >= 0 && rows.indexOf("netDebtIncludingLeases") < rows.indexOf("netDebt"), rows.join(", "));
  assertEqual(assembleTearSheet(mm, meridian).tiles.some((t) => t.factId.startsWith("netDebtIncludingLeases")), false, "no lease tile where no lease line was read");
});
