// test/smokeProd.test.ts (WP-QA08)
// The production smoke check, driven with a mocked fetch and a stub TLS probe: no network.
// One case runs the self-test, which uses real HTTP on 127.0.0.1 only.

import { suite, test, assert, assertEqual } from "./harness";
import {
  parseArgs,
  realTlsProbe,
  renderMarkdown,
  renderText,
  runSmoke,
  type SmokeConfig,
  type SmokeDeps,
  type TlsInfo,
} from "../lib/release/smoke";
import { runSelfTest } from "../lib/release/smokeStub";

const APP = "https://app.tearline.test";
const SITE = "https://tearline.test";
const PASSWORD = "correct-horse-battery-staple";
const COOKIE_SECRET = "s3cr3t-session-value";
const BYPASS = "bypass-token-value-0123";
const COMMIT = "abcdef0123456789abcdef0123456789abcdef01";
const NOW = Date.parse("2026-09-26T12:00:00Z");

function config(over: Partial<SmokeConfig> = {}): SmokeConfig {
  return {
    appUrl: APP,
    siteUrl: SITE,
    email: "demo@tearline.test",
    password: PASSWORD,
    runInput: "03558065",
    expectCommit: null,
    bypassToken: null,
    brandText: "Tearline",
    runTimeoutMs: 150_000,
    pollMs: 2_000,
    allowPartial: false,
    skip: new Set(),
    ...over,
  };
}

const SEC: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "SAMEORIGIN",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=63072000",
  "content-security-policy": "default-src 'self'",
};

type Handler = (req: { method: string; url: string; headers: Headers; body: string }) => Response | null;

interface Mock {
  fetch: typeof fetch;
  calls: { method: string; url: string; headers: Headers; body: string }[];
}

// A healthy production, route by route. `over` replaces a route before the defaults are tried.
function mockFetch(over: Handler = () => null, opts: { runPollsUntilDone?: number; runEnd?: Record<string, unknown> } = {}): Mock {
  const calls: Mock["calls"] = [];
  let polls = 0;
  const json = (status: number, v: unknown, extra: [string, string][] = []) =>
    new Response(JSON.stringify(v), { status, headers: [["content-type", "application/json"], ["cache-control", "no-store"], ...Object.entries(SEC), ...extra] });
  const signedIn = (h: Headers) => (h.get("cookie") ?? "").includes(`sid=${COOKIE_SECRET}`);
  const f = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const body = typeof init.body === "string" ? init.body : "";
    const req = { method, url, headers, body };
    calls.push(req);
    const o = over(req);
    if (o) return o;
    const u = new URL(url);
    const p = u.pathname;
    if (u.origin === APP) {
      if (method === "GET" && p === "/") return new Response("<title>Tearline</title>", { status: 200, headers: { ...SEC, "content-type": "text/html" } });
      if (p === "/api/health")
        return json(200, { status: "ok", ready: true, storeDurable: true, dataMode: "live", cacheBackend: "upstash", commit: COMMIT, region: "lhr1" });
      if (p === "/api/auth/login") {
        const b = JSON.parse(body);
        if (b.password !== PASSWORD) return json(401, { error: "Incorrect email or password." });
        return json(200, { ok: true }, [
          ["set-cookie", `sid=${COOKIE_SECRET}; Path=/; HttpOnly; Secure; SameSite=Lax`],
          ["set-cookie", "sid_h=handle-value; Path=/; HttpOnly; Secure; SameSite=Lax"],
        ]);
      }
      if (method === "POST" && p === "/api/run") {
        if (!signedIn(headers)) return json(401, { error: "You must be signed in." });
        return json(202, { id: "run-1", status: "running" });
      }
      if (method === "GET" && p === "/api/run/run-1") {
        if (!signedIn(headers)) return json(401, { error: "You must be signed in." });
        polls++;
        if (polls < (opts.runPollsUntilDone ?? 3)) return json(200, { id: "run-1", status: "running", elapsedMs: polls * 2000 });
        return json(200, { id: "run-1", status: "done", elapsedMs: 41_000, companyName: "BRISTOL WATER PLC", sheetKey: "sheet-1", reason: null, ...opts.runEnd });
      }
      if (p.startsWith("/api/run/")) return json(401, { error: "You must be signed in." });
      if (p === "/api/model/sheet-1") {
        if (!signedIn(headers)) return json(401, { error: "You must be signed in." });
        const buf = new Uint8Array(4096);
        buf[0] = 0x50;
        buf[1] = 0x4b;
        return new Response(buf, { status: 200, headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } });
      }
    }
    if (u.origin === SITE) {
      if (p === "/") return new Response("<title>Tearline</title><h1>Tearline</h1>", { status: 200, headers: { ...SEC, "content-type": "text/html" } });
      if (p === "/demo") return new Response("<title>Demo</title><form method=post></form>", { status: 200, headers: { "content-type": "text/html" } });
      if (p === "/api/demo") return json(400, { error: "Name and email are required." });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetch: f as typeof fetch, calls };
}

function deps(m: Mock, tls: Partial<TlsInfo> = {}): SmokeDeps {
  let t = NOW;
  return {
    fetch: m.fetch,
    tlsProbe: async () => ({
      authorized: true,
      authorizationError: null,
      protocol: "TLSv1.3",
      validTo: new Date(NOW + 80 * 86_400_000).toUTCString(),
      ...tls,
    }),
    sleep: async (ms) => void (t += ms),
    now: () => t,
  };
}

const verdictOf = (r: { results: { id: string; verdict: string }[] }, id: string) => r.results.find((c) => c.id === id)?.verdict;

suite("smoke-prod / arguments");

test("URLs come from flags or env, and are normalised to a base", () => {
  const a = parseArgs(["--app", "https://app.tearline.test/"], { SMOKE_SITE_URL: "https://tearline.test" });
  assertEqual(a.errors.length, 0, "no errors");
  assertEqual(a.config?.appUrl, "https://app.tearline.test", "trailing slash dropped");
  assertEqual(a.config?.siteUrl, "https://tearline.test", "site from env");
});

test("missing URLs are an error, not a guess", () => {
  const a = parseArgs([], {});
  assert(a.errors.some((e) => e.includes("No app URL")), "app URL demanded");
  assert(a.errors.some((e) => e.includes("No site URL")), "site URL demanded");
  assertEqual(a.config, null, "no config");
});

test("plain http is refused for a real host and allowed for localhost", () => {
  const bad = parseArgs(["--app", "http://app.tearline.test", "--site", "https://tearline.test"], {});
  assert(bad.errors.some((e) => e.includes("must be https")), "http refused");
  const ok = parseArgs(["--app", "http://127.0.0.1:3000", "--site", "http://localhost:3001"], {});
  assertEqual(ok.errors.length, 0, "localhost allowed");
});

test("secrets are refused as arguments and read from env only", () => {
  const a = parseArgs(["--app", APP, "--site", SITE, "--password", "hunter2"], {});
  assert(a.errors.some((e) => e.includes("--password is refused")), "--password refused");
  const b = parseArgs(["--app", "https://u:p@app.tearline.test", "--site", SITE], {});
  assert(b.errors.some((e) => e.includes("credentials inside the URL")), "credentials in URL refused");
  const c = parseArgs(["--app", APP, "--site", SITE], { SMOKE_EMAIL: "d@x.test", SMOKE_PASSWORD: "pw", SMOKE_BYPASS_TOKEN: "tok" });
  assertEqual(c.config?.password, "pw", "password from env");
  assertEqual(c.config?.bypassToken, "tok", "bypass from env");
});

test("unknown flags and unknown skip groups are errors", () => {
  const a = parseArgs(["--app", APP, "--site", SITE, "--frobnicate", "--skip", "health,nope"], {});
  assert(a.errors.some((e) => e.includes("--frobnicate")), "unknown flag");
  assert(a.errors.some((e) => e.includes('"nope"')), "unknown group");
});

suite("smoke-prod / a healthy production");

test("every check passes and the verdict is PASS with exit 0", async () => {
  const m = mockFetch();
  const r = await runSmoke(config({ expectCommit: COMMIT.slice(0, 7) }), deps(m));
  const notPass = r.results.filter((c) => c.verdict !== "pass");
  assertEqual(notPass.map((c) => `${c.id}:${c.detail}`).join(" | "), "", "no check short of pass");
  assertEqual(r.verdict, "PASS", "verdict");
  assertEqual(r.exitCode, 0, "exit code");
  for (const id of ["health.ready", "health.storeDurable", "health.dataMode", "health.commit", "login", "run", "export", "site.landing", "demo.page", "tls.app", "headers.site"]) {
    assertEqual(verdictOf(r, id), "pass", id);
  }
});

test("the run is polled until done and the export uses its sheet key", async () => {
  const m = mockFetch(() => null, { runPollsUntilDone: 4 });
  const r = await runSmoke(config(), deps(m));
  assertEqual(verdictOf(r, "run"), "pass", "run passes");
  assertEqual(m.calls.filter((c) => c.url === `${APP}/api/run/run-1` && c.headers.get("cookie")).length, 4, "four signed-in polls");
  assert(m.calls.some((c) => c.url === `${APP}/api/model/sheet-1`), "export asked for the run's sheet key");
});

test("the demo form is probed with an empty body only, so nothing is ever sent", async () => {
  const m = mockFetch();
  await runSmoke(config(), deps(m));
  const posts = m.calls.filter((c) => c.url === `${SITE}/api/demo`);
  assertEqual(posts.length, 1, "one probe");
  assertEqual(posts[0].body, "{}", "empty submission");
});

suite("smoke-prod / what it must catch");

test("health: not ready, fixtures, memory store, memory cache and a dev commit each fail", async () => {
  const m = mockFetch((q) =>
    q.url.endsWith("/api/health")
      ? new Response(JSON.stringify({ status: "ok", ready: false, storeDurable: false, dataMode: "fixtures", cacheBackend: "memory", commit: "dev" }), { status: 200 })
      : null,
  );
  const r = await runSmoke(config(), deps(m));
  for (const id of ["health.ready", "health.storeDurable", "health.dataMode", "health.cacheBackend", "health.commit"]) assertEqual(verdictOf(r, id), "fail", id);
  assertEqual(r.exitCode, 1, "exit 1");
});

test("health: a commit other than the tagged one fails", async () => {
  const r = await runSmoke(config({ expectCommit: "9999999" }), deps(mockFetch()));
  assertEqual(verdictOf(r, "health.commit"), "fail", "commit mismatch");
});

test("health: a 500 or a redirect to login fails every health line", async () => {
  const r = await runSmoke(config(), deps(mockFetch((q) => (q.url.endsWith("/api/health") ? new Response("", { status: 307 }) : null))));
  assertEqual(verdictOf(r, "health.ready"), "fail", "ready fails");
  assert(r.results.find((c) => c.id === "health.ready")!.detail.includes("307"), "status named");
});

test("headers: no HSTS or no nosniff fails, no CSP only warns", async () => {
  const m = mockFetch((q) => {
    const u = new URL(q.url);
    if (u.origin === APP && u.pathname === "/") return new Response("<title>x</title>", { status: 200, headers: { "x-frame-options": "DENY", "referrer-policy": "no-referrer" } });
    if (u.origin === SITE && u.pathname === "/") {
      const h = { ...SEC };
      delete (h as Record<string, string>)["content-security-policy"];
      return new Response("<title>Tearline</title>", { status: 200, headers: h });
    }
    return null;
  });
  const r = await runSmoke(config(), deps(m));
  assertEqual(verdictOf(r, "headers.app"), "fail", "app missing nosniff and HSTS");
  assertEqual(verdictOf(r, "headers.site"), "warn", "site missing CSP only");
});

test("TLS: an untrusted, an expiring and a plain-http host each fail", async () => {
  const a = await runSmoke(config(), deps(mockFetch(), { authorized: false, authorizationError: "CERT_HAS_EXPIRED" }));
  assertEqual(verdictOf(a, "tls.app"), "fail", "untrusted");
  const b = await runSmoke(config(), deps(mockFetch(), { validTo: new Date(NOW + 5 * 86_400_000).toUTCString() }));
  assertEqual(verdictOf(b, "tls.app"), "fail", "five days left");
  const c = await runSmoke(config(), deps(mockFetch(), { validTo: new Date(NOW + 20 * 86_400_000).toUTCString() }));
  assertEqual(verdictOf(c, "tls.app"), "warn", "twenty days left warns");
  const plain = await realTlsProbe("http://app.tearline.test");
  assertEqual(plain.authorized, false, "the real probe refuses http without a connection");
});

test("login: a refused sign-in fails, and run and export are blocked, not passed", async () => {
  const m = mockFetch((q) => (q.url.endsWith("/api/auth/login") ? new Response(JSON.stringify({ error: "Incorrect email or password." }), { status: 401 }) : null));
  const r = await runSmoke(config(), deps(m));
  assertEqual(verdictOf(r, "login"), "fail", "login fails");
  assertEqual(verdictOf(r, "run"), "skip", "run blocked");
  assertEqual(verdictOf(r, "export"), "skip", "export blocked");
  assertEqual(r.verdict, "FAIL", "FAIL wins over skips");
});

test("login: a wrong password that is accepted fails", async () => {
  const m = mockFetch((q) =>
    q.url.endsWith("/api/auth/login")
      ? new Response(JSON.stringify({ ok: true }), { status: 200, headers: [["set-cookie", `sid=${COOKIE_SECRET}; HttpOnly; Secure`]] })
      : null,
  );
  const r = await runSmoke(config(), deps(m));
  assertEqual(verdictOf(r, "login.refuses-bad-password"), "fail", "wrong password accepted is a fail");
});

test("login: a session cookie without Secure fails on https", async () => {
  const m = mockFetch((q) =>
    q.url.endsWith("/api/auth/login") && !q.body.includes("-wrong")
      ? new Response(JSON.stringify({ ok: true }), { status: 200, headers: [["set-cookie", `sid=${COOKIE_SECRET}; Path=/; HttpOnly`]] })
      : null,
  );
  const r = await runSmoke(config(), deps(m));
  assertEqual(verdictOf(r, "login"), "fail", "no Secure flag");
});

test("login: missing credentials fail rather than skip", async () => {
  const r = await runSmoke(config({ email: null, password: null }), deps(mockFetch()));
  assertEqual(verdictOf(r, "login"), "fail", "credentials demanded");
});

test("run: a run still going at the timeout fails and the export is blocked", async () => {
  const m = mockFetch(() => null, { runPollsUntilDone: 10_000 });
  const r = await runSmoke(config({ runTimeoutMs: 20_000 }), deps(m));
  assertEqual(verdictOf(r, "run"), "fail", "timed out");
  assertEqual(verdictOf(r, "export"), "skip", "export blocked");
});

test("run: partial fails unless --allow-partial, which warns and still exports", async () => {
  const end = { status: "partial", reason: "the accounts scan timed out" };
  const a = await runSmoke(config(), deps(mockFetch(() => null, { runEnd: end })));
  assertEqual(verdictOf(a, "run"), "fail", "partial fails");
  const b = await runSmoke(config({ allowPartial: true }), deps(mockFetch(() => null, { runEnd: end })));
  assertEqual(verdictOf(b, "run"), "warn", "partial warns");
  assertEqual(verdictOf(b, "export"), "pass", "export still runs");
});

test("run: a pick list fails and says to use a number", async () => {
  const r = await runSmoke(config(), deps(mockFetch(() => null, { runEnd: { status: "needs-choice", sheetKey: null } })));
  assertEqual(verdictOf(r, "run"), "fail", "needs-choice fails");
  assert(r.results.find((c) => c.id === "run")!.detail.includes("Companies House number"), "advice given");
});

test("run: a run readable while signed out fails the wall check", async () => {
  const m = mockFetch((q) =>
    q.url === `${APP}/api/run/run-1` && !q.headers.get("cookie") ? new Response(JSON.stringify({ id: "run-1", status: "done" }), { status: 200 }) : null,
  );
  const r = await runSmoke(config(), deps(m));
  assertEqual(verdictOf(r, "run.signed-out-wall"), "fail", "wall breach caught");
});

test("export: an HTML page or an empty body is not a workbook", async () => {
  const m = mockFetch((q) => (q.url.includes("/api/model/") ? new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }) : null));
  const r = await runSmoke(config(), deps(m));
  assertEqual(verdictOf(r, "export"), "fail", "wrong type");
});

test("site: a vercel.app link, the working title or a missing brand each fail", async () => {
  const m = mockFetch((q) =>
    new URL(q.url).origin === SITE && new URL(q.url).pathname === "/"
      ? new Response('<title>Origination (working title)</title><a href="https://product-two-mu.vercel.app">app</a>', { status: 200, headers: SEC })
      : null,
  );
  const r = await runSmoke(config(), deps(m));
  const d = r.results.find((c) => c.id === "site.landing")!;
  assertEqual(d.verdict, "fail", "landing fails");
  assert(d.detail.includes("vercel.app") && d.detail.includes("working title") && d.detail.includes("Tearline"), "all three named");
});

test("demo: an accepted empty submission or a missing endpoint fails", async () => {
  const a = await runSmoke(config(), deps(mockFetch((q) => (q.url.endsWith("/api/demo") ? new Response("{}", { status: 200 }) : null))));
  assertEqual(verdictOf(a, "demo.refuses-empty"), "fail", "accepted empty");
  const b = await runSmoke(config(), deps(mockFetch((q) => (q.url.endsWith("/api/demo") ? new Response("", { status: 404 }) : null))));
  assertEqual(verdictOf(b, "demo.refuses-empty"), "fail", "no endpoint");
});

test("a network error is a fail with the reason, not a crash", async () => {
  const m = mockFetch((q) => {
    if (q.url.endsWith("/api/health")) throw new Error("getaddrinfo ENOTFOUND app.tearline.test");
    return null;
  });
  const r = await runSmoke(config(), deps(m));
  assert(r.results.find((c) => c.id === "health.ready")!.detail.includes("ENOTFOUND"), "reason kept");
});

suite("smoke-prod / verdicts and secrets");

test("a skipped group makes the verdict INCOMPLETE with exit 3, never PASS", async () => {
  const r = await runSmoke(config({ skip: new Set(["demo"]) }), deps(mockFetch()));
  assertEqual(r.verdict, "INCOMPLETE", "incomplete");
  assertEqual(r.exitCode, 3, "exit 3");
});

test("the bypass token is sent on every request and printed nowhere", async () => {
  const m = mockFetch();
  const r = await runSmoke(config({ bypassToken: BYPASS }), deps(m));
  assert(m.calls.length > 10, "requests made");
  assert(m.calls.every((c) => c.headers.get("x-vercel-protection-bypass") === BYPASS), "header on every request");
  const out = renderText(r) + renderMarkdown(r) + JSON.stringify(r);
  assert(!out.includes(BYPASS), "token absent from output");
});

test("the password and the session cookie never reach the output", async () => {
  const r = await runSmoke(config(), deps(mockFetch()));
  const out = renderText(r) + renderMarkdown(r) + JSON.stringify(r);
  assert(!out.includes(PASSWORD), "password absent");
  assert(!out.includes(COOKIE_SECRET), "cookie absent");
});

test("the self-test passes a healthy stub and fails a broken one over local HTTP", async () => {
  const r = await runSelfTest();
  assertEqual(r.good.verdict, "PASS", "good stub passes");
  assertEqual(r.broken.verdict, "FAIL", "broken stub fails");
  assertEqual(r.missed.join(","), "", "every planted fault caught");
  assert(r.ok, "self-test ok");
});
