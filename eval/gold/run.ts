// eval/gold/run.ts
// The CI gate for extraction on REAL SEC filings. Runs frozen Company-Facts snapshots
// through the actual mapEdgarToManifest -> ladder -> verify path and scores the four
// cells. Hard-fails (exit 1) on any wrongly-surfaced figure (a fabrication or a drifted
// value) or any abstention miss. Deterministic (no network), so it is safe in CI.
//
// Run: npx tsx eval/gold/run.ts   (or npm run eval:us)

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { mapEdgarToManifest, type CompanyFacts, type Submissions } from "../../lib/sources/secEdgar";
import { US_GOLD } from "./us";

const here = dirname(fileURLToPath(import.meta.url));
const within = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.01, Math.abs(b) * 0.005);

let correctlySurfaced = 0, correctlyAbstained = 0, wronglySurfaced = 0, wronglyAbstained = 0;
const problems: string[] = [];

for (const g of US_GOLD) {
  const cf = JSON.parse(readFileSync(join(here, "fixtures", `${g.filer}.json`), "utf8")) as CompanyFacts;
  const m = mapEdgarToManifest({ cik: g.cik, name: g.name } as Submissions, cf);
  for (const [metric, expected] of Object.entries(g.expect)) {
    const f = m.facts[`${metric}.${g.period}`];
    const got = f && typeof f.value === "number" ? f.value : null;
    if (expected === "ABSTAIN") {
      if (got === null) correctlyAbstained++;
      else {
        wronglySurfaced++;
        problems.push(`${g.filer} ${metric}: surfaced ${got}, expected ABSTAIN`);
      }
    } else if (got === null) {
      wronglyAbstained++;
      problems.push(`${g.filer} ${metric}: abstained, expected ${expected}`);
    } else if (!within(got, expected)) {
      wronglySurfaced++;
      problems.push(`${g.filer} ${metric}: surfaced ${got}, expected ${expected}${g.verified.includes(metric) ? " (hand-verified vs 10-K)" : ""}`);
    } else if (!f!.provenance || !f!.provenance.sourceId) {
      // A right value with NO provenance is not a real extraction: gate it, so a synthesised number
      // cannot pass on value alone. (Every base/derived fact the pipeline emits carries provenance.)
      wronglySurfaced++;
      problems.push(`${g.filer} ${metric}: value ${got} carries no provenance`);
    } else if (g.verified.includes(metric) && f!.rung !== "R1") {
      // A HAND-VERIFIED metric is a reported base line; it must resolve at R1 (reported), never a
      // lower-rung proxy. This grounds the rung, not just the value, for the cells we checked by hand.
      wronglySurfaced++;
      problems.push(`${g.filer} ${metric}: value ${got} at rung ${f!.rung}, expected R1 (hand-verified base line)`);
    } else {
      correctlySurfaced++;
    }
  }
}

const surfaced = correctlySurfaced + wronglySurfaced;
const precision = surfaced ? correctlySurfaced / surfaced : 1;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

console.log("\nSEC real-data gold eval  (eval/gold/us.ts)\n" + "=".repeat(48));
console.log(`filers                ${US_GOLD.length}   (${US_GOLD.map((g) => g.filer).join(", ")})`);
console.log(`correctly-surfaced    ${correctlySurfaced}`);
console.log(`correctly-abstained   ${correctlyAbstained}`);
console.log(`wrongly-surfaced      ${wronglySurfaced}   <- fabrication/drift (must be 0)`);
console.log(`wrongly-abstained     ${wronglyAbstained}   (recall leak / drift)`);
console.log("-".repeat(48));
console.log(`PRECISION on surfaced ${pct(precision)}   (target 100%)`);
if (problems.length) {
  console.log("\nPROBLEMS:");
  for (const p of problems) console.log("  " + p);
}
console.log("");

// Fabrication and abstention are hard gates. A recall leak (wrongly-abstained) is a
// soft signal here (drift), so it warns but does not fail on its own.
process.exit(wronglySurfaced > 0 ? 1 : 0);
