// eval/gold/uk/tags.ts
// Prints the tag-derived figures for the frozen iXBRL and ESEF cases, read by the existing
// extractors (lib/sources/ixbrl.ts extractFinancials, lib/sources/esef.ts
// extractEsefFinancials). No model and no eye reads these, which is why uk.ts marks them
// "tag-derived". Deterministic, no network.
//
// Run from product/:  npx tsx eval/gold/uk/tags.ts

import { existsSync, readdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { extractFinancials } from "../../../lib/sources/ixbrl";
import { extractEsefFinancials, type EsefDoc } from "../../../lib/sources/esef";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, "..", "fixtures", "uk");
// Used only when the frozen ESEF file was over the size rule and is not on disk.
const ESEF_TEST_FIXTURE = join(here, "..", "..", "..", "test", "fixtures", "tesco_esef.json");

for (const folder of readdirSync(FIXTURES).sort()) {
  const metaPath = join(FIXTURES, folder, "meta.json");
  if (!existsSync(metaPath)) continue;
  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  if (meta.format !== "xhtml" && meta.format !== "esef") continue;

  let path = join(FIXTURES, folder, meta.file);
  if (!existsSync(path)) {
    if (meta.format !== "esef") {
      console.log(`# ${folder}: ${meta.file} not on disk, run freeze.ts ${meta.companyNumber}`);
      continue;
    }
    path = ESEF_TEST_FIXTURE;
  }
  const raw = readFileSync(path, "utf8");
  const fin = meta.format === "xhtml"
    ? extractFinancials(raw)
    : extractEsefFinancials(JSON.parse(raw) as EsefDoc);
  console.log(`# ${folder} (${meta.format}, source ${path === ESEF_TEST_FIXTURE ? "test/fixtures/tesco_esef.json" : meta.file}) period ${fin?.periodEnd ?? "none"}`);
  for (const l of fin?.lines ?? []) {
    console.log(`  ${l.metric} | ${l.value} | ${l.unit} | ${l.concept} | ctx ${l.contextRef || "-"} | end ${l.periodEnd} | raw "${l.rawText}"`);
  }
}
