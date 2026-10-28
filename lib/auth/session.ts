// lib/auth/session.ts
// The signed session envelope carried in an httpOnly cookie. Binds a signed-in user to a
// tenant, which is the choke point the whole MNPI wall stands on: every store call is
// already tenant-scoped, so once getTenantId() resolves from a verified session, a user can
// only ever see their own tenant's data. Expiry is enforced on decode; the server-side
// session table (db/migrations/0002_auth.sql) provides revocation the signature cannot.

import { sign, verify } from "./crypto";
import { isProd } from "../config/prodGuard";

export const SESSION_COOKIE = "sid";

export interface Session {
  userId: string;
  tenantId: string;
  email: string;
  exp: number; // unix seconds
}

const DEV_SECRET = "dev-insecure-secret-set-AUTH_SECRET";

// The signing secret for every session envelope and token fingerprint. In production a strong
// AUTH_SECRET is mandatory: without it the envelope could be forged for any tenant, so we refuse
// to sign or verify rather than fall back to a public constant. The dev fallback is allowed only
// outside production so the local demo runs with nothing configured.
export function authSecret(): string {
  const s = process.env.AUTH_SECRET;
  if (s && s !== DEV_SECRET) return s;
  // isProd() checks VERCEL_ENV as well as NODE_ENV, so a Vercel production deployment that did not
  // stamp NODE_ENV cannot silently fall back to the public dev secret and forge session envelopes.
  if (isProd()) {
    throw new Error(
      "AUTH_SECRET must be set to a strong, non-default value in production (the MNPI wall depends on it).",
    );
  }
  return DEV_SECRET;
}

export function encodeSession(s: Session, secret = authSecret()): string {
  return sign(JSON.stringify(s), secret);
}

export function decodeSession(token: string | undefined, secret = authSecret()): Session | null {
  if (!token) return null;
  const json = verify(token, secret);
  if (!json) return null;
  try {
    const s = JSON.parse(json) as Session;
    if (!s.userId || !s.tenantId) return null;
    if (typeof s.exp === "number" && s.exp * 1000 < Date.now()) return null; // expired
    return s;
  } catch {
    return null;
  }
}
