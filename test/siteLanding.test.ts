// test/siteLanding.test.ts (WP-QA05)
// The narrative site's landing, checked at the source so smoke-prod's site.landing cannot fail
// after a deploy: no "working title", no link to a vercel.app host, and the name Tearline on the
// landing (page, layout metadata, footer). Reads sites/narrative from disk, no build needed.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { suite, test, assert } from "./harness";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SITE = join(REPO, "sites", "narrative");
const SKIP = new Set(["node_modules", ".next", "out", "build", ".vercel", "fonts"]);
const TEXT = /\.(tsx?|jsx?|mjs|css|html|json|md)$|^\.env\.example$|^vercel\.json$/;

function* walk(dir: string): Generator<string> {
  for (const n of readdirSync(dir)) {
    if (SKIP.has(n)) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (TEXT.test(n)) yield p;
  }
}

function offenders(re: RegExp): string[] {
  const out: string[] = [];
  for (const f of walk(SITE)) {
    readFileSync(f, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (re.test(line)) out.push(`${relative(REPO, f)}:${i + 1}`);
      });
  }
  return out;
}

const read = (p: string) => readFileSync(join(SITE, p), "utf8");

suite("site / landing");

test('no "working title" anywhere in sites/narrative', () => {
  const hits = offenders(/working title/i);
  assert(hits.length === 0, `"working title" found at ${hits.join(", ")}`);
});

test("no vercel.app host anywhere in sites/narrative", () => {
  const hits = offenders(/vercel\.app/i);
  assert(hits.length === 0, `vercel.app found at ${hits.join(", ")}`);
});

test("the landing carries Tearline in the page, the footer and the metadata", () => {
  const page = read("app/page.tsx");
  const layout = read("app/layout.tsx");
  // WP-SS01-SS04 replaced the text masthead with the wordmark SVG and moved the copyright into
  // the shared Footer, which the landing renders.
  assert(/<img src="\/brand\/wordmark-[a-z]+\.svg" alt="Tearline"/.test(page), "the masthead wordmark reads Tearline");
  assert(/<Footer \/>/.test(page), "the landing renders the shared footer");
  assert(/&copy; \{year\} Tearline/.test(read("components/narrative/dom/Footer.tsx")), "the footer reads Tearline");
  assert(/(title:\s*|const TITLE = )"Tearline/.test(layout), "the page title starts with Tearline");
  assert(/Tearline/.test(read("components/narrative/dom/Act3Product.tsx")), "the product fine print reads Tearline");
});

test("the demo link comes from NEXT_PUBLIC_APP_URL, not a hardcoded host", () => {
  const act3 = read("components/narrative/dom/Act3Product.tsx");
  assert(/process\.env\.NEXT_PUBLIC_APP_URL/.test(act3), "Act3Product reads NEXT_PUBLIC_APP_URL");
  assert(!/const DEMO_URL = "https?:/.test(act3), "DEMO_URL is not a hardcoded absolute URL");
  assert(/NEXT_PUBLIC_APP_URL=/.test(read(".env.example")), "sites/narrative/.env.example documents it");
});
