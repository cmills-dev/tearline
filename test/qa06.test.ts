// test/qa06.test.ts
// WP-QA06, security review and bug hunt round 2. Each case here proves one fix for a finding
// ranked in docs/programme/audit/security-review.md, and each was a failing assertion before its
// fix. No network: the "Upstash down" case points the limiter at a closed local port.

import { suite, test, assert, assertEqual } from "./harness";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { NextRequest } from "next/server";
import { UpstashRateLimiter, type RateLimitResult } from "../lib/ratelimit/ratelimit";
import { guardApiRequest, MAX_BODY_BYTES } from "../lib/http/requestGuard";
import { readJsonObject } from "../lib/http/body";
import { contentSecurityPolicy, securityHeaders } from "../lib/http/securityHeaders";
import { securityHeaders as siteSecurityHeaders } from "../../sites/narrative/lib/securityHeaders";
import nextConfig from "../next.config";
import { middleware } from "../middleware";

const HERE = dirname(fileURLToPath(import.meta.url));
const headers = (h: Record<string, string>) => ({ get: (k: string) => h[k.toLowerCase()] ?? null });

export async function registerQa06Tests(): Promise<void> {
  // -------------------------------------------------------------------------------------------
  // S3. The shared limiter failed open: with Upstash unreachable every check answered ok, so the
  // login limits vanished during an outage (probe: 24 of 24 wrong passwords answered 401, no 429).
  // It now counts per process instead.
  // -------------------------------------------------------------------------------------------
  const down = new UpstashRateLimiter({ url: "http://127.0.0.1:1", token: "none" });
  const checks: RateLimitResult[] = [];
  for (let i = 0; i < 3; i++) checks.push(await down.check("qa06:login:ip:203.0.113.9", 2, 60));
  const peeked = await down.peek("qa06:login:ip:203.0.113.9");

  suite("QA06 S3 / the rate limit holds with Upstash down");
  test("the third call over a limit of two is refused", () => {
    assertEqual(checks[0].ok, true, "first");
    assertEqual(checks[1].ok, true, "second");
    assertEqual(checks[2].ok, false, "third is over the limit");
    assert(checks.every((c) => c.degraded === true), "every result says the shared counter was not consulted");
  });
  test("peek reads the fallback count, so the failed-login gate still sees failures", () => {
    assertEqual(peeked.count, 3, "count");
    assert(peeked.resetSeconds > 0, `reset ${peeked.resetSeconds}`);
  });

  // -------------------------------------------------------------------------------------------
  // S4. Login CSRF and cross-origin writes: any Origin was accepted on every POST.
  // S5. No body cap: a 20 MB login body was buffered whole before the route answered.
  // -------------------------------------------------------------------------------------------
  const host = "127.0.0.1:3126";
  suite("QA06 S4 / cross-origin writes are refused before any route");
  test("a POST from another origin is 403", () => {
    const v = guardApiRequest("POST", "/api/auth/login", headers({ host, origin: "https://evil.example" }));
    assertEqual(v?.status, 403, "evil origin");
  });
  test("an opaque origin (sandboxed frame, data: URL) is 403", () => {
    assertEqual(guardApiRequest("POST", "/api/run", headers({ host, origin: "null" }))?.status, 403, "Origin: null");
  });
  test("a same-origin POST passes", () => {
    assertEqual(guardApiRequest("POST", "/api/auth/login", headers({ host, origin: `http://${host}` })), null, "same origin");
  });
  test("behind a proxy the forwarded host is the one compared", () => {
    const h = headers({ host: "internal:3000", "x-forwarded-host": "tearline.app", origin: "https://tearline.app" });
    assertEqual(guardApiRequest("POST", "/api/run", h), null, "forwarded host matches");
  });
  test("a POST with no Origin (curl, cron, smoke scripts) passes unless the browser says cross-site", () => {
    assertEqual(guardApiRequest("POST", "/api/run", headers({ host })), null, "no origin");
    assertEqual(guardApiRequest("POST", "/api/run", headers({ host, "sec-fetch-site": "cross-site" }))?.status, 403, "cross-site");
  });
  test("reads and non-API paths are not touched", () => {
    assertEqual(guardApiRequest("GET", "/api/model/x", headers({ host, origin: "https://evil.example" })), null, "GET");
    assertEqual(guardApiRequest("POST", "/login", headers({ host, origin: "https://evil.example" })), null, "page");
  });
  test("the middleware answers 403 to a cross-origin login", async () => {
    const res = await middleware(
      new NextRequest(`http://${host}/api/auth/login`, { method: "POST", headers: { origin: "https://evil.example", host } }),
    );
    assertEqual(res.status, 403, "middleware status");
  });

  suite("QA06 S5 / request bodies are capped at 1 MB");
  test("a declared length over the cap is 413 before the body is read", () => {
    const v = guardApiRequest("POST", "/api/auth/login", headers({ host, origin: `http://${host}`, "content-length": String(MAX_BODY_BYTES + 1) }));
    assertEqual(v?.status, 413, "declared length");
  });
  test("a streamed body over the cap reads as an empty object", async () => {
    const big = new ReadableStream<Uint8Array>({
      start(c) {
        const chunk = new Uint8Array(256 * 1024).fill(0x20);
        for (let i = 0; i < 8; i++) c.enqueue(chunk);
        c.close();
      },
    });
    const req = new Request("http://x/api", { method: "POST", body: big, duplex: "half" } as RequestInit);
    const parsed = await readJsonObject(req);
    assertEqual(Object.keys(parsed).length, 0, "oversized stream");
  });
  test("a normal body still parses", async () => {
    const parsed = await readJsonObject<{ email: string }>(
      new Request("http://x/api", { method: "POST", body: JSON.stringify({ email: "a@b.c" }) }),
    );
    assertEqual(parsed.email, "a@b.c", "email");
  });

  // -------------------------------------------------------------------------------------------
  // S2. No CSP, HSTS, framing or sniffing headers under next start, and X-Powered-By: Next.js.
  // -------------------------------------------------------------------------------------------
  suite("QA06 S2 / security headers on every response");
  // The CSP carries a per-request nonce (WP-QA05), so it comes from middleware, and the static
  // headers come from next.config.ts. Together they are the set QA06 S2 asks for.
  test("the app sets HSTS and the rest on every path, and no X-Powered-By", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    const all = rules.find((r) => r.source === "/:path*");
    assert(all, "a rule for every path");
    const keys = new Set(all!.headers.map((h) => h.key.toLowerCase()));
    for (const k of ["strict-transport-security", "x-frame-options", "x-content-type-options", "referrer-policy", "permissions-policy"]) {
      assert(keys.has(k), `missing ${k}`);
    }
    assertEqual(nextConfig.poweredByHeader, false, "poweredByHeader");
  });
  test("the middleware sets a CSP on a page response", async () => {
    const res = await middleware(new NextRequest(`http://${host}/login`, { headers: { host } }));
    const csp = res.headers.get("content-security-policy") ?? "";
    assert(/script-src [^;]*'nonce-/.test(csp), csp);
  });
  test("the production CSP forbids framing by others, plugins and eval", () => {
    const csp = contentSecurityPolicy({ NODE_ENV: "production" });
    assert(csp.includes("frame-ancestors 'self'"), csp);
    assert(csp.includes("object-src 'none'"), csp);
    assert(!csp.includes("unsafe-eval"), csp);
    assert(securityHeaders({ NODE_ENV: "production" }).some((h) => h.key === "Strict-Transport-Security" && /max-age=\d{8}/.test(h.value)), "HSTS two years");
  });
  test("the narrative site carries the same set", () => {
    const keys = siteSecurityHeaders({ NODE_ENV: "production" }).map((h) => h.key);
    assert(keys.includes("Content-Security-Policy") && keys.includes("Strict-Transport-Security"), keys.join(","));
  });

  // -------------------------------------------------------------------------------------------
  // B1. The invite link /login?invite=<token> opened the login form, and the register form never
  // sent the token, so an invited user could not register in production (invite-only).
  // -------------------------------------------------------------------------------------------
  suite("QA06 B1 / the invite link reaches register");
  test("the login page reads ?invite= and sends it with register", () => {
    const src = readFileSync(join(HERE, "..", "app", "login", "page.tsx"), "utf8");
    assert(/searchParams|URLSearchParams\(window\.location\.search\)\.get\("invite"\)/.test(src), "reads the invite param");
    assert(/\{ email, password, invite \}/.test(src), "sends it in the register body");
  });
}
