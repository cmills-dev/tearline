// product/scripts/brand-check.ts (WP-QA08, BR-13)
// The brand acceptance check, run from product/: npx tsx scripts/brand-check.ts [--json]
// The logic lives in brand/scripts/brand-check.mjs so the brand package owns its own rules.
// Exits 1 on any finding: working title, Winnova, a Privileged legend, an em-dash on a launch
// surface, a hex colour that matches no token, or a contrast pair under 4.5:1.

import { spawnSync } from "child_process";
import { join } from "path";

const script = join(__dirname, "..", "..", "brand", "scripts", "brand-check.mjs");
const r = spawnSync(process.execPath, [script, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
