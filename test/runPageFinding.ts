// test/runPageFinding.ts - runs only the page-finding suite (WP-BE15), for a quick loop.
//   ./node_modules/.bin/tsx test/runPageFinding.ts
import "./pageFinding.test";
import { run } from "./harness";

run().then((failed) => process.exit(failed > 0 ? 1 : 0));
