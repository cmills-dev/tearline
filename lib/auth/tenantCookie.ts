// lib/auth/tenantCookie.ts
// The anonymous tenant cookie, parsed and verified in one pure place (WP-QA05, closing WP-QA03
// D3). Before this, lib/tenant.ts returned the raw `tid` cookie and middleware.ts kept any value a
// browser sent, and anonymous and registered tenants shared one id space. So without
// AUTH_REQUIRED, `Cookie: tid=<a registered tenant id>` opened that desk's workspace.
//
// The rules now:
//   - an anonymous tenant id always starts with `anon_`; a registered tenant id (a bare UUID from
//     /api/auth/register) never does, so the two spaces cannot collide;
//   - the cookie value is `<tenant id>.<HMAC-SHA256 of the id, base64url>`, keyed by
//     TENANT_COOKIE_SECRET; an id without the prefix is refused even with a valid signature;
//   - a missing, forged or re-keyed cookie means a NEW anonymous tenant (the middleware mints one),
//     and never a shared fallback bucket;
//   - with AUTH_REQUIRED=1 the cookie is not read at all: a verified session or nothing.
//
// Web Crypto only (crypto.subtle), no node:crypto, so the same code runs in the edge middleware
// and in route handlers. No next/headers import, so the tests call it directly.

import { isProd } from "../config/prodGuard";

export const TENANT_COOKIE = "tid";
export const ANON_PREFIX = "anon_";

const DEV_TENANT_SECRET = "dev-insecure-tenant-cookie-secret";
const ANON_ID = /^anon_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The key for the tid signature. Outside production the dev constant keeps the local demo running
// with nothing configured. In production anonymous mode is off (the prod guard requires
// AUTH_REQUIRED=1 and the middleware then mints nothing), so this only throws if someone runs
// anonymous mode in production without the secret, which must not pass silently.
export function tenantCookieSecret(env: NodeJS.ProcessEnv = process.env): string {
  const s = env.TENANT_COOKIE_SECRET;
  if (s && s !== DEV_TENANT_SECRET) return s;
  if (isProd(env)) {
    throw new Error("TENANT_COOKIE_SECRET must be set to run anonymous tenants in production.");
  }
  return DEV_TENANT_SECRET;
}

// True for any tenant id that is not bound to a verified identity: the `anon_` space, the old
// shared "anon" fallback, and the empty id.
export function isAnonymousTenant(tenantId: string): boolean {
  return !tenantId || tenantId === "anon" || tenantId.startsWith(ANON_PREFIX);
}

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(secret: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data))));
}

// Constant-time for equal lengths; the lengths of a SHA-256 base64url signature are public.
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function mintTenantCookie(secret: string): Promise<{ tenantId: string; value: string }> {
  const tenantId = `${ANON_PREFIX}${crypto.randomUUID()}`;
  return { tenantId, value: `${tenantId}.${await hmac(secret, tenantId)}` };
}

// The anonymous tenant id a cookie value proves, or null if it proves nothing.
export async function verifyTenantCookie(value: string | undefined, secret: string): Promise<string | null> {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot < 0) return null;
  const tenantId = value.slice(0, dot);
  if (!ANON_ID.test(tenantId)) return null;
  return sameText(value.slice(dot + 1), await hmac(secret, tenantId)) ? tenantId : null;
}

// The tenant for a request. The session must already be verified by the caller (lib/tenant.ts
// checks the signed envelope and, with a database, the live session row). An empty string means
// no tenant: every route answers 401 on it and every page shows the sign-in gate.
export async function resolveTenantId(input: {
  session: { tenantId: string } | null;
  authRequired: boolean;
  tidCookie: string | undefined;
  secret?: string;
}): Promise<string> {
  if (input.session) return input.session.tenantId;
  if (input.authRequired) return "";
  return (await verifyTenantCookie(input.tidCookie, input.secret ?? tenantCookieSecret())) ?? "";
}
