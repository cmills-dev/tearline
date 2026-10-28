// test/deepen.test.ts
// Engine A deepening: year-on-year trend deltas, the model (CSV) export, and the
// consolidated Sources/references panel. All deterministic, computed in code.

import { buildManifest } from "../lib/engine/buildManifest";
import {
  assembleTearSheet,
  computeDelta,
  toCsv,
} from "../lib/engine/assemble";
import type { TearSheet } from "../lib/engine/assemble";
import { meridian } from "../lib/sources/fixtures/meridian";
import { redacta } from "../lib/sources/fixtures/redacta";
import type { Fact } from "../lib/engine/types";
import { suite, test, assert, assertEqual } from "./harness";

const mm = assembleTearSheet(buildManifest(meridian), meridian);
const rr = assembleTearSheet(buildManifest(redacta), redacta);

function must<T>(v: T | undefined, msg: string): T {
  if (v === undefined) throw new Error(`missing: ${msg}`);
  return v;
}
function row(ts: TearSheet, metric: string) {
  return must(
    ts.financials.rows.find((r) => r.metric === metric),
    `financial row ${metric}`
  );
}

suite("deepen / trend (year-on-year)");

test("turnover rises c.10% year on year, computed in code", () => {
  const d = row(mm, "turnover").delta;
  assertEqual(d.status, "computed", "both periods resolve");
  assertEqual(d.direction, "up", "48.2m > 43.8m");
  assert(d.absDisplay === "+£4.4m", `abs was ${d.absDisplay}`);
  assertEqual(d.pctDisplay, "+10.0%", "4.4m / 43.8m");
});

test("leverage delta is the fulcrum figure and improves (down)", () => {
  const d = row(mm, "leverage").delta;
  assertEqual(d.status, "computed", "2.08x vs 2.93x");
  assertEqual(d.direction, "down", "leverage fell");
  assert(d.isFulcrum, "leverage carries the maroon accent");
  assert(d.absDisplay.startsWith("−"), `signed negative, was ${d.absDisplay}`);
});

test("single-period lines show a labelled blank, not a delta", () => {
  const d = row(mm, "totalAssets").delta; // only FY2024 filed
  assertEqual(d.status, "single-period", "no prior figure");
  assertEqual(d.absDisplay, "\u2013", "blank (an en-dash), not a guess");
  assert(!!d.note, "reason retained");
});

test("redacta (one period on file) never fabricates a trend", () => {
  const d = row(rr, "operatingProfit").delta;
  assertEqual(d.status, "single-period", "single filed period");
});

test("a delta is never computed across an R4 abstain", () => {
  const latest = { rung: "R2", value: 100, kind: "currency", unit: "GBP" } as unknown as Fact;
  const prior = { rung: "R4", value: null, kind: "currency", unit: "GBP" } as unknown as Fact;
  const d = computeDelta(latest, prior, true, false);
  assertEqual(d.status, "abstain", "R4 on either side blocks the delta");
  assertEqual(d.direction, "none", "no direction across an abstain");
});

test("a delta is never computed across a unit change", () => {
  const gbp = { rung: "R1", value: 100, kind: "currency", unit: "GBP" } as unknown as Fact;
  const usd = { rung: "R1", value: 90, kind: "currency", unit: "USD" } as unknown as Fact;
  const d = computeDelta(gbp, usd, true, false);
  assertEqual(d.status, "abstain", "different units block the delta");
  assert(/units differ/i.test(d.note ?? ""), "the note names the unit change");
});

test("a delta spanning different rungs is computed but flagged", () => {
  const r1 = { rung: "R1", value: 120, kind: "currency", unit: "GBP" } as unknown as Fact;
  const r3 = { rung: "R3", value: 100, kind: "currency", unit: "GBP" } as unknown as Fact;
  const d = computeDelta(r1, r3, true, false);
  assertEqual(d.status, "computed", "same unit -> a delta is produced");
  assert(/rung/i.test(d.note ?? ""), "the note flags the rung span");
});

suite("deepen / model export (CSV)");

test("reported metric exports its raw value, rung and hash", () => {
  const r = must(
    mm.exportRows.find((x) => x.metric === "turnover" && x.period === "FY2024"),
    "turnover export row"
  );
  assertEqual(r.value, "48200000", "raw stored value, not the display string");
  assertEqual(r.rung, "R1", "reported");
  assert(r.contentHash.startsWith("fnv1a:"), "traces to a real content hash");
  assert(r.sourceDocument.length > 0, "source document present");
});

test("an abstained metric exports honestly: empty value, rung R4", () => {
  const r = must(
    rr.exportRows.find((x) => x.metric === "turnover" && x.period === "FY2024"),
    "redacta turnover export row"
  );
  assertEqual(r.value, "", "no value invented");
  assertEqual(r.rung, "R4", "abstain, not hidden");
});

test("toCsv emits the declared header and quotes comma fields", () => {
  const csv = toCsv(mm.exportRows);
  const lines = csv.split("\r\n");
  assertEqual(
    lines[0],
    "metric,label,period,value,unit,rung,verification_status,source_document,source_locator,content_hash",
    "header row"
  );
  assert(
    csv.includes('"Full accounts, year ended 31 December 2024"'),
    "a field containing a comma is quoted"
  );
  assertEqual(lines.length, mm.exportRows.length + 1, "one line per fact plus header");
});

suite("deepen / references (Sources panel)");

test("references consolidate distinct passages, none synthesised or empty", () => {
  assert(mm.references.length > 0, "references built");
  assert(
    !mm.references.some((r) => r.documentName === "Derived line (see inputs)"),
    "derived lines are not cited as sources"
  );
  mm.references.forEach((r, i) => assertEqual(r.citation, i + 1, "sequential citations"));
});

test("one passage backs several figures (creditors note backs three lines)", () => {
  const note12 = must(
    mm.references.find((r) => r.locator === "Note 12 Creditors, p.22"),
    "creditors note reference"
  );
  assertEqual(note12.backs.length, 3, "borrowings + term loan + RCF");
});

test("an R3 proxy is cross-referenced back to its borrowed source passage", () => {
  const opRef = must(
    rr.references.find((r) => r.locator === "Note 2 Operating profit, p.3"),
    "operating profit reference"
  );
  assert(
    opRef.backs.some((b) => b.factId === "operatingProfit.FY2024"),
    "backs the reported EBIT"
  );
  assert(
    opRef.backs.some((b) => b.factId === "ebitda.FY2024"),
    "and the EBITDA proxy that borrows it"
  );
});
