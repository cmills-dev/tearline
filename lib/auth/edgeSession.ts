// lib/auth/edgeSession.ts
// The session envelope check the middleware runs (WP-FE01). The middleware is on the edge
// runtime, so it cannot import lib/auth/session.ts, which pulls in node:crypto. This reads the
// same format with Web Crypto: `<base64url JSON>.<base64url HMAC-SHA256 of the first part>`,
// keyed by AUTH_SECRET, naming a user and a tenant, not expired. test/fe01.test.ts signs a cookie
// with lib/auth/session.ts and checks this accepts it, so the two cannot drift.
//
// It proves the envelope is ours and current. It does not prove the session was not revoked:
// lib/tenant.ts checks the live session row, so a revoked cookie still resolves to no tenant.

import { isProd } from "../config/prodGuard";

// Mirrors lib/auth/session.ts (SESSION_COOKIE and the dev fallback secret).
export const SESSION_COOKIE = "sid";
const AUTH_SECRET_DEV_FALLBACK = "dev-insecure-secret-set-AUTH_SECRET";

// The session signing key, as lib/auth/session.ts authSecret() chooses it, except that a missing
// secret in production means null (every session fails, so the gate stays shut) instead of a throw.
export function sessionSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const s = env.AUTH_SECRET;
  if (s && s !== AUTH_SECRET_DEV_FALLBACK) return s;
  return isProd(env) ? null : AUTH_SECRET_DEV_FALLBACK;
}

function base64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(text: string): string | null {
  try {
    const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

// Constant-time for equal lengths; the length of a SHA-256 base64url signature is public.
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// True when the value is a session envelope signed with this secret, naming a user and a tenant,
// and not expired. The same checks as decodeSession() in lib/auth/session.ts.
export async function verifySessionEnvelope(
  value: string | undefined,
  secret: string | null,
  nowMs: number = Date.now(),
): Promise<boolean> {
  if (!value || !secret) return false;
  const dot = value.lastIndexOf(".");
  if (dot < 0) return false;
  const body = value.slice(0, dot);
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = base64urlEncode(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body))));
  if (!sameText(value.slice(dot + 1), expected)) return false;
  const json = base64urlDecode(body);
  if (!json) return false;
  try {
    const s = JSON.parse(json) as { userId?: unknown; tenantId?: unknown; exp?: unknown };
    if (!s.userId || !s.tenantId) return false;
    if (typeof s.exp === "number" && s.exp * 1000 < nowMs) return false;
    return true;
  } catch {
    return false;
  }
}
