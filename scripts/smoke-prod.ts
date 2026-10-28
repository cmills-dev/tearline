// scripts/smoke-prod.ts (WP-QA08, TQ-15)
// The production smoke check. Run from product/:
//
//   npx tsx scripts/smoke-prod.ts --self-test
//       No target needed. Starts a local stub of the app and site on 127.0.0.1, runs every check
//       over real HTTP, and proves the smoke passes a healthy deploy and fails a broken one.
//
//   npx tsx scripts/smoke-prod.ts --dry-run --app <url> --site <url>
//       Prints the resolved target, which secrets are set (never their values) and the plan.
//       Sends no request.
//
//   SMOKE_EMAIL=... SMOKE_PASSWORD=... SMOKE_RUN_INPUT=<CH number> \
//     npx tsx scripts/smoke-prod.ts --app https://app.<domain> --site https://<domain> \
//       [--expect-commit <sha>] [--out ../docs/programme/evidence/release-<date>-smoke.md]
//       The real run. On a protected Vercel preview, set SMOKE_BYPASS_TOKEN as well.
//
// Other flags: --json, --allow-partial, --run-timeout <seconds>, --skip <group,group>,
// --brand-text <text>. SMOKE_APP_URL and SMOKE_SITE_URL may replace --app and --site.
// Secrets come from the environment only. --password, --email and --bypass-token are refused.
//
// Exit codes: 0 PASS, 1 FAIL, 2 bad arguments, 3 INCOMPLETE (a check was skipped and none failed).
// The checks themselves live in lib/release/smoke.ts, where the unit tests drive them.

import { writeFileSync } from "node:fs";
import { parseArgs, realDeps, renderMarkdown, renderPlan, renderText, runSmoke } from "../lib/release/smoke";
import { runSelfTest } from "../lib/release/smokeStub";

const HELP = `smoke-prod.ts: the production smoke check (WP-QA08)

  --self-test                  run against a local stub, no target needed
  --dry-run                    print the plan, send nothing
  --app <url> --site <url>     the deployed app and site (or SMOKE_APP_URL, SMOKE_SITE_URL)
  --run-input <CH number>      the demo name to run (or SMOKE_RUN_INPUT)
  --expect-commit <sha>        fail unless /api/health reports this commit (or SMOKE_EXPECT_COMMIT)
  --out <file.md>              also write the result as a markdown evidence table
  --json                       print the report as JSON
  --allow-partial              a partial run warns instead of failing
  --run-timeout <seconds>      default 150
  --skip <groups>              tls,headers,health,login,run,export,site,demo. Makes the verdict INCOMPLETE
  --brand-text <text>          text the site landing must carry, default Tearline

  Secrets, environment only: SMOKE_EMAIL, SMOKE_PASSWORD, SMOKE_BYPASS_TOKEN
  Exit: 0 PASS, 1 FAIL, 2 bad arguments, 3 INCOMPLETE`;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2), process.env);
  if (args.mode === "help") {
    console.log(HELP);
    return 0;
  }
  if (args.errors.length) {
    for (const e of args.errors) console.error(`smoke-prod: ${e}`);
    console.error("Run with --help for usage.");
    return 2;
  }

  if (args.mode === "self-test") {
    const r = await runSelfTest();
    if (args.json) console.log(JSON.stringify(r, null, 2));
    else {
      console.log("Self-test, healthy stub (must PASS):\n");
      console.log(renderText(r.good));
      console.log("\nSelf-test, broken stub (must FAIL):\n");
      console.log(renderText(r.broken));
      if (r.missed.length) console.log(`\nThe broken stub was not caught on: ${r.missed.join(", ")}`);
      console.log(`\nSelf-test ${r.ok ? "PASSED" : "FAILED"}. TLS is a stub probe here. The real probe runs only against https.`);
    }
    return r.ok ? 0 : 1;
  }

  const config = args.config!;
  if (args.mode === "dry-run") {
    console.log(renderPlan(config));
    return 0;
  }

  const report = await runSmoke(config, realDeps());
  console.log(args.json ? JSON.stringify(report, null, 2) : renderText(report));
  if (args.out) {
    writeFileSync(args.out, renderMarkdown(report));
    console.log(`\nWrote ${args.out}`);
  }
  return report.exitCode;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`smoke-prod: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    process.exit(1);
  },
);
