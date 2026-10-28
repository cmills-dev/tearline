// middleware.ts
// Four jobs, in this order, on every page and API request (WP-FE01 added the first two;
// WP-QA05 added the CSP nonce and hardened the tenant cookie; both apply on every request,
// including when AUTH_REQUIRED=1):
//
//   1. Hidden routes. /onboarding/assistant and the ten non-launch routes answer 404 in
//      production; SHOW_NON_LAUNCH_ROUTES=1 brings them back. The list lives in
//      lib/config/launchRoutes.ts and nowhere else.
//   2. The sign-in gate. With AUTH_REQUIRED=1 a request without a verified session is sent to
//      /login?next=<the page asked for>, or answered 401 if it is an API call. Login, the auth
//      routes, health and cron stay open. The kb ingest writes to the shared plane, so it needs a
//      session even in the anonymous demo mode. The gate checks the signed session envelope
//      (signature and expiry) with Web Crypto; revocation is checked downstream, where
//      lib/tenant.ts looks up the live session row, so a revoked cookie still resolves to no
//      tenant and every route answers 401 on it.
//   3. The anonymous tenant. Without AUTH_REQUIRED, assigns an anonymous tenant id on first visit
//      and carries it in an httpOnly cookie. This gives every visitor a stable, isolated workspace
//      with no login: the id keys every store write/read (see lib/tenant.ts, lib/workspace.ts). A
//      signed-in session binds the tenant to the user instead, and this is the fallback.
//   4. The Content-Security-Policy with a fresh nonce (WP-QA05, lib/http/csp.ts). The policy goes
//      on the request too, because that is where Next reads the nonce it stamps on its own inline
//      scripts. It is set here and not in vercel.json, so every host sends it, on every response
//      this middleware produces, including the ones the sign-in gate would otherwise short-circuit.
//
// The tid cookie is signed and anonymous ids carry the `anon_` prefix (lib/auth/tenantCookie.ts).
// A missing, forged or re-keyed cookie is replaced by a freshly minted one, so a browser can
// never name its own tenant (WP-QA05, closing WP-QA03 D3). With AUTH_REQUIRED=1 there is no
// anonymous tenant at all, so nothing is minted and TENANT_COOKIE_SECRET is not needed.
//
// The id is also written onto the incoming request cookies so the SAME request's
// server components read it immediately (not only the next request).
//
// This file runs on the edge runtime, so the session check is lib/auth/edgeSession.ts, a Web
// Crypto reading of the envelope lib/auth/session.ts signs.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isProd } from "./lib/config/prodGuard";
import { buildCsp, newNonce } from "./lib/http/csp";
import { isApiPath, isHiddenRoute, isPublicPath, needsSessionAlways } from "./lib/config/launchRoutes";
import { SESSION_COOKIE, sessionSecret, verifySessionEnvelope } from "./lib/auth/edgeSession";
import { guardApiRequest } from "./lib/http/requestGuard";
import { mintTenantCookie, TENANT_COOKIE, tenantCookieSecret, verifyTenantCookie } from "./lib/auth/tenantCookie";

const ONE_YEAR = 60 * 60 * 24 * 365;

function hiddenResponse(): NextResponse {
  return new NextResponse(
    '<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Not found</title></head><body><p>Not found.</p><p><a href="/">Back to the entry field</a></p></body></html>',
    { status: 404, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

function signedOutResponse(req: NextRequest): NextResponse {
  const { pathname, search } = req.nextUrl;
  if (isApiPath(pathname)) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  const login = req.nextUrl.clone();
  login.pathname = "/login";
  login.search = "";
  login.hash = "";
  login.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(login);
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  // Cross-origin writes and oversized bodies stop here, before any route (WP-QA06 S4, S5).
  const refused = guardApiRequest(req.method, pathname, req.headers);
  if (refused) return NextResponse.json({ error: refused.error }, { status: refused.status });
  if (isHiddenRoute(pathname)) return hiddenResponse();

  const authRequired = process.env.AUTH_REQUIRED === "1";
  if (!isPublicPath(pathname) && (authRequired || needsSessionAlways(pathname))) {
    const signedIn = await verifySessionEnvelope(req.cookies.get(SESSION_COOKIE)?.value, sessionSecret());
    if (!signedIn) return signedOutResponse(req);
  }

  let minted: string | null = null;
  if (!authRequired) {
    const secret = tenantCookieSecret();
    if (!(await verifyTenantCookie(req.cookies.get(TENANT_COOKIE)?.value, secret))) {
      minted = (await mintTenantCookie(secret)).value;
      req.cookies.set(TENANT_COOKIE, minted); // visible to this request's server components
    }
  }

  const nonce = newNonce();
  const csp = buildCsp(nonce, { dev: process.env.NODE_ENV === "development" });
  const headers = new Headers(req.headers); // copied after the cookie write above, so it carries it
  headers.set("x-nonce", nonce);
  headers.set("content-security-policy", csp);

  const res = NextResponse.next({ request: { headers } });
  res.headers.set("Content-Security-Policy", csp);
  if (minted) {
    res.cookies.set(TENANT_COOKIE, minted, {
      httpOnly: true,
      sameSite: "lax",
      // Secure in production so the tenant cookie is never sent over plaintext HTTP; left off in
      // dev so the local http://localhost demo still receives it.
      secure: isProd(),
      path: "/",
      maxAge: ONE_YEAR,
    });
  }
  return res;
}

// Run on pages and API routes, not on static assets or the health check.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/health).*)"],
};
