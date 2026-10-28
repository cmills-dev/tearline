// test/qa05c.test.ts
// WP-QA05 hardening, from the 27 Sep local preview (docs/programme/evidence/local-preview-smoke-2026-09-27.md):
//   - both apps send a strict Content-Security-Policy and the static security headers on every
//     host, not only through vercel.json, and neither sends X-Powered-By
//   - POST /api/run works in fixtures mode (no CH_API_KEY) for the bundled illustrative borrowers,
//     so the smoke export check has a sheet to export
// No network, no model, no database.

import { suite, test, assert, assertEqual } from "./harness";
import { createHash } from "crypto";
import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { NextRequest } from "next/server";
import { buildCsp, newNonce, STATIC_SECURITY_HEADERS } from "../lib/http/csp";
import * as siteCsp from "../../sites/narrative/lib/csp";
import { inlineScriptHashes, sceneCsp, sceneHeaders } from "../../sites/narrative/lib/sceneCsp";
import { DEFAULTS } from "../lib/release/smoke";
import { InMemoryRunStore } from "../lib/run/store";
import { createRun, executeRun } from "../lib/run/runner";
import { buildFixtureManifest, fixtureForInput, FixtureRegisterClient } from "../lib/run/fixtureRun";
import type { FactManifest } from "../lib/engine/types";

const HERE = dirname(fileURLToPath(import.meta.url));
const PRODUCT = join(HERE, "..");
const SITE = join(HERE, "..", "..", "sites", "narrative");

suite("WP-QA05 hardening: CSP, headers, fixtures-mode runs");

function directives(csp: string): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const part of csp.split(";").map((s) => s.trim()).filter(Boolean)) {
    const [name, ...values] = part.split(/\s+/);
    m.set(name, values);
  }
  return m;
}

// --- The policy ----------------------------------------------------------------------------

test("the CSP is strict on scripts: self, the nonce and strict-dynamic, no unsafe-inline or eval", () => {
  const d = directives(buildCsp("abc123"));
  assertEqual(d.get("script-src")?.join(" "), "'self' 'nonce-abc123' 'strict-dynamic'", "script-src");
  assertEqual(d.get("object-src")?.join(" "), "'none'", "object-src");
  assertEqual(d.get("base-uri")?.join(" "), "'self'", "base-uri");
  assertEqual(d.get("frame-ancestors")?.join(" "), "'self'", "frame-ancestors, which smoke-prod also accepts for framing");
  assertEqual(d.get("default-src")?.join(" "), "'self'", "default-src");
  assertEqual(d.get("form-action")?.join(" "), "'self'", "form-action");
  assert(!/unsafe-eval/.test(buildCsp("n")), "no eval in production");
  assert(/'unsafe-eval'/.test(directives(buildCsp("n", { dev: true })).get("script-src")!.join(" ")), "dev tooling gets eval");
});

test("a nonce is fresh per call and carries 128 bits", () => {
  const a = newNonce();
  const b = newNonce();
  assert(a !== b, "two nonces differ");
  assertEqual(Buffer.from(a, "base64").length, 16, "16 random bytes");
});

test("the static headers cover what smoke-prod checks, HSTS included", () => {
  const h = new Map(STATIC_SECURITY_HEADERS.map((x) => [x.key.toLowerCase(), x.value]));
  assertEqual(h.get("x-content-type-options"), "nosniff", "nosniff");
  assertEqual(h.get("x-frame-options"), "SAMEORIGIN", "frame options");
  assert(!!h.get("referrer-policy"), "referrer policy");
  const maxAge = Number(/max-age=(\d+)/.exec(h.get("strict-transport-security") ?? "")?.[1]);
  assert(maxAge >= DEFAULTS.hstsMinSeconds, `HSTS max-age ${maxAge} >= ${DEFAULTS.hstsMinSeconds}`);
});

test("the site's copy of the policy matches the app's", () => {
  assertEqual(siteCsp.buildCsp("n1"), buildCsp("n1"), "production policy");
  assertEqual(siteCsp.buildCsp("n1", { dev: true }), buildCsp("n1", { dev: true }), "dev policy");
  assertEqual(JSON.stringify(siteCsp.STATIC_SECURITY_HEADERS), JSON.stringify(STATIC_SECURITY_HEADERS), "static headers");
});

// --- Where the headers are set -------------------------------------------------------------

test("both next.config files switch off X-Powered-By and send the static headers on every path", async () => {
  for (const [label, dir] of [["app", PRODUCT], ["site", SITE]] as const) {
    const cfg = (await import(join(dir, "next.config.ts"))).default;
    const conf = cfg.default ?? cfg;
    assertEqual(conf.poweredByHeader, false, `${label}: poweredByHeader`);
    const rules = (await conf.headers()) as { source: string; headers: { key: string; value: string }[] }[];
    const all = rules.find((r) => r.source === "/:path*" && r.headers.some((h) => h.key === "X-Content-Type-Options"));
    assert(!!all, `${label}: a /:path* rule carries the static headers`);
    assertEqual(JSON.stringify(all!.headers), JSON.stringify(STATIC_SECURITY_HEADERS), `${label}: the same set`);
  }
});

test("vercel.json no longer carries the static headers, so there is one source for them", () => {
  for (const f of [join(PRODUCT, "vercel.json"), join(SITE, "vercel.json")]) {
    const text = readFileSync(f, "utf8");
    assert(!/X-Content-Type-Options|X-Frame-Options|Referrer-Policy/.test(text), `${f} has no duplicate security header`);
  }
});

test("the app middleware sets the CSP on the response and on the request, with one nonce", async () => {
  const { middleware } = await import("../middleware");
  const res = await middleware(new NextRequest("http://localhost/"));
  const csp = res.headers.get("content-security-policy") ?? "";
  const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
  assert(!!nonce, `a nonce in the response policy: ${csp}`);
  // NextResponse.next({ request: { headers } }) carries the overridden request headers as x-middleware-request-*.
  assertEqual(res.headers.get("x-middleware-request-content-security-policy"), csp, "the request carries the same policy");
  assertEqual(res.headers.get("x-middleware-request-x-nonce"), nonce!, "and the nonce");
  const again = await middleware(new NextRequest("http://localhost/"));
  assert(again.headers.get("content-security-policy") !== csp, "a fresh nonce per request");
});

test("the site middleware sets the CSP and leaves the scene files to their hash policy", async () => {
  const { middleware, config } = await import("../../sites/narrative/middleware");
  // The site has its own copy of next, so its NextRequest type is a different declaration.
  const csp = middleware(new NextRequest("http://localhost/") as unknown as Parameters<typeof middleware>[0]).headers.get("content-security-policy") ?? "";
  assert(/'nonce-[^']+'/.test(csp) && /'strict-dynamic'/.test(csp), `site policy: ${csp}`);
  const matcher = new RegExp(`^${config.matcher[0]}$`);
  assert(matcher.test("/"), "the landing is matched");
  assert(!matcher.test("/scene/factgraph.html"), "a scene file is not matched");
});

test("both root layouts render per request, so Next can stamp the nonce", () => {
  for (const f of [join(PRODUCT, "app", "layout.tsx"), join(SITE, "app", "layout.tsx")]) {
    assert(/export const dynamic = "force-dynamic"/.test(readFileSync(f, "utf8")), `${f} is force-dynamic`);
  }
});

test("every inline script in a scene page is hashed into its policy, and nothing else is", () => {
  const dir = join(SITE, "public", "scene");
  const pages = readdirSync(dir).filter((n) => n.endsWith(".html"));
  assert(pages.length >= 2, "the scene pages are there");
  const rules = new Map(sceneHeaders(dir).map((r) => [r.source, r.headers[0].value]));
  for (const n of pages) {
    const html = readFileSync(join(dir, n), "utf8");
    const bodies = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
    assert(bodies.length > 0, `${n} has inline scripts`);
    const policy = rules.get(`/scene/${n}`) ?? "";
    for (const b of bodies) {
      const h = createHash("sha256").update(b, "utf8").digest("base64");
      assert(policy.includes(`'sha256-${h}'`), `${n}: hash of an inline script is allowed`);
    }
    assert(!/unsafe-inline/.test(directives(policy).get("script-src")!.join(" ")), `${n}: no unsafe-inline scripts`);
  }
  assertEqual(inlineScriptHashes('<script src="/a.js"></script>').length, 0, "a src script is not hashed");
  assert(!sceneCsp(inlineScriptHashes("<script>evil()</script>")).includes(inlineScriptHashes("<script>good()</script>")[0]), "a different script gets a different hash");
});

// --- /api/run in fixtures mode -------------------------------------------------------------

test("fixtures mode knows the bundled borrowers and nothing else", () => {
  assertEqual(fixtureForInput("12000000")?.key, "redacta", "Redacta by number");
  assertEqual(fixtureForInput("redacta")?.key, "redacta", "by name");
  assertEqual(fixtureForInput("Tesco PLC"), undefined, "a real company is not a fixture");
  assertEqual(fixtureForInput("00445790"), undefined, "nor is a real number");
});

test("a fixtures-mode run of 12000000 finishes done with a saved, illustrative sheet", async () => {
  const store = new InMemoryRunStore();
  const saved: { key: string; manifest: FactManifest }[] = [];
  const deps = {
    store,
    resolveClient: new FixtureRegisterClient(),
    build: buildFixtureManifest,
    persist: async (_t: string, key: string, manifest: FactManifest) => {
      saved.push({ key, manifest });
    },
  };
  const run = await createRun("tenant-a", "12000000", deps);
  const done = await executeRun(run, deps);
  assertEqual(done.status, "done", `status (${done.reason ?? ""})`);
  assertEqual(done.sheetKey, "ch-12000000", "sheet key");
  assertEqual(saved.length, 1, "one sheet saved");
  assert(saved[0].manifest.entity.synthetic === true, "the saved sheet is stamped synthetic");
  for (const s of done.stages) {
    assert(s.status !== "pending" && s.status !== "running", `${s.stage} settled (${s.status})`);
  }
});

test("the run route no longer refuses fixtures mode outright", () => {
  const src = readFileSync(join(PRODUCT, "app", "api", "run", "route.ts"), "utf8");
  assert(/!live && !fixtureForInput\(input\)/.test(src), "the 503 is only for a non-fixture input without a key");
  assert(!/if \(!process\.env\.CH_API_KEY\)/.test(src), "no unconditional key check");
  assert(/executeRun\(run, deps\)/.test(src), "the fixture deps reach the runner");
});
