// test/fe01.test.ts
// WP-FE01: the sign-in gate, the hidden routes and the return path after sign-in. The middleware
// is called with hand-built requests, as in test/qa05.test.ts; no server, no network. Each case
// sets the environment it needs and puts the old one back, so the order of suites does not matter.

import { suite, test, assert, assertEqual } from "./harness";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { NextRequest } from "next/server";
import { middleware } from "../middleware";
import { encodeSession, decodeSession, SESSION_COOKIE } from "../lib/auth/session";
import { sessionSecret, verifySessionEnvelope, SESSION_COOKIE as EDGE_SESSION_COOKIE } from "../lib/auth/edgeSession";
import {
  HIDDEN_ROUTES,
  LAUNCH_ROUTES,
  NON_LAUNCH_ROUTES,
  isHiddenRoute,
  isPublicPath,
  nonLaunchRoutesHidden,
  safeReturnPath,
} from "../lib/config/launchRoutes";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..", "app");
const SECRET = "fe01-test-secret-long-enough-to-pass-the-gate";
const TENANT = "3f1c2a9e-4b7d-4e21-9a55-0c6f1d2e8b40";

const ENV_KEYS = ["AUTH_REQUIRED", "AUTH_SECRET", "SHOW_NON_LAUNCH_ROUTES", "VERCEL_ENV", "TENANT_COOKIE_SECRET"] as const;

// Runs fn with exactly these variables set (the rest of ENV_KEYS unset), then restores them.
async function withEnv<T>(vars: Partial<Record<(typeof ENV_KEYS)[number], string>>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) {
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// A bare environment for the pure functions that take one.
function env(vars: Record<string, string>): NodeJS.ProcessEnv {
  return vars as unknown as NodeJS.ProcessEnv;
}

function sessionCookie(expOffsetSeconds = 3600, secret = SECRET): string {
  const exp = Math.floor(Date.now() / 1000) + expOffsetSeconds;
  return encodeSession({ userId: "u-1", tenantId: TENANT, email: "desk@example.com", exp }, secret);
}

function req(path: string, cookie?: string, method = "GET"): NextRequest {
  return new NextRequest(`http://app.test${path}`, { method, headers: cookie ? { cookie } : {} });
}

function isPassThrough(res: Response): boolean {
  return res.status === 200 && res.headers.get("x-middleware-next") === "1";
}

suite("FE01 / sign-in gate with AUTH_REQUIRED=1");

export async function registerFe01Tests(): Promise<void> {
  const enforced = { AUTH_REQUIRED: "1", AUTH_SECRET: SECRET };
  const good = `${SESSION_COOKIE}=${sessionCookie()}`;

  const pageOut = await withEnv(enforced, () => middleware(req("/workspace?tab=recent")));
  const sheetOut = await withEnv(enforced, () => middleware(req("/sheet/abc")));
  const rootOut = await withEnv(enforced, () => middleware(req("/")));
  const apiOut = await withEnv(enforced, () => middleware(req("/api/run", undefined, "POST")));
  const pageIn = await withEnv(enforced, () => middleware(req("/workspace", good)));
  const apiIn = await withEnv(enforced, () => middleware(req("/api/run", good, "POST")));
  const forged = await withEnv(enforced, () => middleware(req("/workspace", `${SESSION_COOKIE}=${sessionCookie(3600, "another-secret-entirely-long-enough")}`)));
  const expired = await withEnv(enforced, () => middleware(req("/workspace", `${SESSION_COOKIE}=${sessionCookie(-60)}`)));
  const exempt: Record<string, Response> = {};
  for (const p of ["/login", "/login?next=%2Fworkspace", "/api/auth/login", "/api/auth/logout", "/api/auth/register", "/api/health", "/api/cron/monitor", "/favicon.ico", "/_next/static/chunk.js"]) {
    exempt[p] = await withEnv(enforced, () => middleware(req(p, undefined, p.startsWith("/api/auth") ? "POST" : "GET")));
  }
  const noSecretProd = await withEnv({ AUTH_REQUIRED: "1", VERCEL_ENV: "production", SHOW_NON_LAUNCH_ROUTES: "1" }, () =>
    middleware(req("/workspace", `${SESSION_COOKIE}=${sessionCookie(3600, "dev-insecure-secret-set-AUTH_SECRET")}`)),
  );

  test("a signed-out page request goes to /login with the page it asked for", () => {
    assertEqual(pageOut.status, 307, "redirect status");
    const loc = new URL(pageOut.headers.get("location") ?? "");
    assertEqual(loc.pathname, "/login", "to the login page");
    assertEqual(loc.searchParams.get("next"), "/workspace?tab=recent", "path and query carried as next");
    assertEqual(new URL(sheetOut.headers.get("location") ?? "").searchParams.get("next"), "/sheet/abc", "the sheet too");
    assertEqual(new URL(rootOut.headers.get("location") ?? "").pathname, "/login", "the run entry too");
  });
  test("a signed-out API request gets 401, not a redirect", async () => {
    assertEqual(apiOut.status, 401, "401 for /api/run");
    assertEqual(apiOut.headers.get("location"), null, "no redirect for an API call");
    const body = (await apiOut.json()) as { error?: string };
    assert(!!body.error, "a readable error");
  });
  test("a valid session passes, pages and API alike", () => {
    assert(isPassThrough(pageIn), `page status ${pageIn.status}`);
    assert(isPassThrough(apiIn), `api status ${apiIn.status}`);
  });
  test("a session signed with another key, or expired, counts as signed out", () => {
    assertEqual(forged.status, 307, "forged envelope redirected");
    assertEqual(expired.status, 307, "expired envelope redirected");
  });
  test("login, auth, health, cron and static files stay open", () => {
    for (const [p, res] of Object.entries(exempt)) assert(isPassThrough(res), `${p} answered ${res.status}`);
  });
  test("in production without AUTH_SECRET the gate stays shut, even for the dev-key envelope", () => {
    assertEqual(noSecretProd.status, 307, "no secret means no session");
  });

  suite("FE01 / the edge check reads the envelope lib/auth/session.ts signs");
  const envelope = sessionCookie();
  const edgeOk = await verifySessionEnvelope(envelope, SECRET);
  const nodeOk = decodeSession(envelope, SECRET);
  const dot = envelope.lastIndexOf(".");
  const tamperedBody = `${Buffer.from(JSON.stringify({ userId: "u-1", tenantId: "someone-else", exp: 9999999999 })).toString("base64url")}${envelope.slice(dot)}`;
  const edgeTampered = await verifySessionEnvelope(tamperedBody, SECRET);
  const edgeNoTenant = await verifySessionEnvelope(encodeSession({ userId: "u-1", tenantId: "", email: "", exp: 9999999999 }, SECRET), SECRET);
  const edgeNull = await verifySessionEnvelope(envelope, null);
  test("a cookie signed by encodeSession verifies on the edge and in node alike", () => {
    assert(edgeOk, "edge accepts it");
    assert(!!nodeOk, "node accepts it");
    assertEqual(EDGE_SESSION_COOKIE, SESSION_COOKIE, "same cookie name");
  });
  test("a changed body, a missing tenant or no secret is refused", () => {
    assert(!edgeTampered, "tampered body refused");
    assert(!edgeNoTenant, "empty tenant refused");
    assert(!edgeNull, "null secret refused");
  });
  test("the secret choice mirrors authSecret(): dev fallback outside production only", () => {
    assertEqual(sessionSecret(env({ AUTH_SECRET: SECRET })), SECRET, "set secret used");
    assertEqual(sessionSecret(env({})), "dev-insecure-secret-set-AUTH_SECRET", "dev fallback in dev");
    assertEqual(sessionSecret(env({ VERCEL_ENV: "production" })), null, "none in production");
    assertEqual(sessionSecret(env({ VERCEL_ENV: "production", AUTH_SECRET: "dev-insecure-secret-set-AUTH_SECRET" })), null, "dev value refused in production");
  });

  suite("FE01 / the kb ingest needs a session in every mode");
  const ingestAnon = await withEnv({ AUTH_SECRET: SECRET }, () => middleware(req("/api/kb/ingest", undefined, "POST")));
  const ingestSigned = await withEnv({ AUTH_SECRET: SECRET }, () => middleware(req("/api/kb/ingest", good, "POST")));
  const entitiesAnon = await withEnv({ AUTH_SECRET: SECRET }, () => middleware(req("/api/kb/entities")));
  test("anonymous demo mode: ingest without a session is 401", () => {
    assertEqual(ingestAnon.status, 401, "signed-out ingest refused");
  });
  test("anonymous demo mode: ingest with a session passes, and reads stay open", () => {
    assertEqual(ingestSigned.status, 200, "signed-in ingest passes");
    assertEqual(ingestSigned.headers.get("location"), null, "no redirect");
    assertEqual(entitiesAnon.status, 200, "the entity list is not gated by this rule");
  });

  suite("FE01 / hidden routes");
  const prod = { AUTH_REQUIRED: "1", AUTH_SECRET: SECRET, VERCEL_ENV: "production" };
  const prodHidden: Record<string, Response> = {};
  for (const p of [...HIDDEN_ROUTES, "/kb/anything", "/sec/", "//pipeline"]) {
    prodHidden[p] = await withEnv(prod, () => middleware(req(p, good)));
  }
  const prodHiddenSignedOut = await withEnv(prod, () => middleware(req("/watchlist")));
  const prodLaunch: Record<string, Response> = {};
  for (const p of ["/", "/live", "/run/abc", "/sheet/abc", "/workspace", "/esef"]) {
    prodLaunch[p] = await withEnv(prod, () => middleware(req(p, good)));
  }
  const prodFlagOn = await withEnv({ ...prod, SHOW_NON_LAUNCH_ROUTES: "1" }, () => middleware(req("/onboarding/assistant", good)));
  const devShown = await withEnv({ AUTH_REQUIRED: "1", AUTH_SECRET: SECRET }, () => middleware(req("/kb", good)));
  const devForcedHidden = await withEnv({ AUTH_REQUIRED: "1", AUTH_SECRET: SECRET, SHOW_NON_LAUNCH_ROUTES: "0" }, () => middleware(req("/kb", good)));

  test("in production /onboarding/assistant and the ten non-launch routes answer 404", () => {
    assertEqual(NON_LAUNCH_ROUTES.length, 10, "ten non-launch routes");
    assert(HIDDEN_ROUTES.includes("/onboarding/assistant"), "the assistant is hidden");
    for (const [p, res] of Object.entries(prodHidden)) assertEqual(res.status, 404, `${p} is 404`);
    assertEqual(prodHiddenSignedOut.status, 404, "404 for a signed-out visitor too, not a login bounce");
  });
  test("in production the launch routes still pass", () => {
    for (const [p, res] of Object.entries(prodLaunch)) assert(isPassThrough(res), `${p} answered ${res.status}`);
  });
  test("SHOW_NON_LAUNCH_ROUTES=1 brings them back; dev shows them; =0 hides them in dev", () => {
    assert(isPassThrough(prodFlagOn), `flag on in production: ${prodFlagOn.status}`);
    assert(isPassThrough(devShown), `dev: ${devShown.status}`);
    assertEqual(devForcedHidden.status, 404, "forced hidden in dev");
  });
  test("the flag logic, on its own", () => {
    assertEqual(nonLaunchRoutesHidden(env({ NODE_ENV: "production" })), true, "NODE_ENV production hides");
    assertEqual(nonLaunchRoutesHidden(env({ NODE_ENV: "development" })), false, "development shows");
    assertEqual(isHiddenRoute("/onboardingx", env({ NODE_ENV: "production" })), false, "a prefix is a path segment, not a string prefix");
    assertEqual(isHiddenRoute("/live", env({ NODE_ENV: "production" })), false, "a launch route is never hidden");
  });
  test("no launch route is on the hidden list", () => {
    for (const r of LAUNCH_ROUTES) assert(!HIDDEN_ROUTES.includes(r), `${r} is launch and hidden`);
  });
  test("each hidden route's page, or its server layout, calls the same guard", () => {
    for (const r of HIDDEN_ROUTES) {
      const dir = join(APP, ...r.slice(1).split("/"));
      const files = ["page.tsx", "layout.tsx"].map((f) => join(dir, f)).filter((f) => existsSync(f));
      const guarded = files.some((f) => readFileSync(f, "utf8").includes(`isHiddenRoute("${r}")`));
      assert(guarded, `${r} has no isHiddenRoute("${r}") guard`);
    }
  });

  suite("FE01 / return path and sign out");
  test("safeReturnPath keeps a same-origin path and drops everything else", () => {
    assertEqual(safeReturnPath("/workspace?tab=recent"), "/workspace?tab=recent", "path and query kept");
    assertEqual(safeReturnPath("/sheet/abc#caps"), "/sheet/abc#caps", "hash kept");
    assertEqual(safeReturnPath(null), "/", "missing goes home");
    assertEqual(safeReturnPath("https://evil.example/x"), "/", "absolute URL refused");
    assertEqual(safeReturnPath("//evil.example/x"), "/", "protocol-relative refused");
    assertEqual(safeReturnPath("/\\evil.example"), "/", "backslash refused");
    assertEqual(safeReturnPath("javascript:alert(1)"), "/", "scheme refused");
    assertEqual(safeReturnPath("/login?next=/x"), "/", "no loop back to login");
  });
  test("isPublicPath does not open a page by its file extension", () => {
    assert(!isPublicPath("/sheet/abc.pdf"), "a sheet path with a dot stays gated");
    assert(isPublicPath("/favicon.ico") && isPublicPath("/icon.png") && isPublicPath("/opengraph-image"), "metadata files open");
    assert(!isPublicPath("/loginx") && !isPublicPath("/api/authx"), "prefixes match whole segments");
  });
  const loginSrc = readFileSync(join(APP, "login", "page.tsx"), "utf8");
  const layoutSrc = readFileSync(join(APP, "layout.tsx"), "utf8");
  const signOutSrc = readFileSync(join(APP, "components", "SignOutButton.tsx"), "utf8");
  test("the login page returns to ?next= through safeReturnPath", () => {
    assert(/safeReturnPath\(\s*new URLSearchParams\(window\.location\.search\)\.get\("next"\)\s*\)/.test(loginSrc), "login follows next");
  });
  test("the header shows Sign out, which revokes through /api/auth/logout and lands on /login", () => {
    assert(layoutSrc.includes("<SignOutButton />"), "layout renders the control");
    assert(/fetch\("\/api\/auth\/logout", \{ method: "POST" \}\)/.test(signOutSrc), "posts to logout");
    assert(signOutSrc.includes('window.location.href = "/login"'), "lands on /login");
  });
  const afterSignOut = await withEnv(enforced, () => middleware(req("/workspace")));
  test("after sign out (no session cookie) the gate sends the browser back to /login", () => {
    assertEqual(afterSignOut.status, 307, "redirected");
  });
}
