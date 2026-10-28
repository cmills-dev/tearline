// lib/auth/issue.ts
// Issue a session after a login or a registration: one server-side row, the signed envelope and
// the handle cookie. Shared by both routes so the two cannot drift (WP-QA05):
//   - A handle cookie the browser already carries is revoked first. Login used to leave the old
//     row live, so a handle copied before the new sign-in still resolved to a session.
//   - The cookies are Secure whenever isProd() says production, which checks VERCEL_ENV as well
//     as NODE_ENV. The routes read NODE_ENV alone, so a Vercel production deployment without
//     NODE_ENV stamped sent session cookies over plain HTTP.

import { isProd } from "../config/prodGuard";
import { encodeSession, SESSION_COOKIE, type Session } from "./session";
import { SESSION_HANDLE_COOKIE, type AuthStore, type AuthUser } from "./store";

export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // one week

export interface SessionCookieOptions {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: string;
  maxAge: number;
}

// The part of Next's cookie jar this needs, so a test can hand in a plain object.
export interface CookieJar {
  get(name: string): { value: string } | undefined;
  set(name: string, value: string, options: SessionCookieOptions): unknown;
}

export function sessionCookieOptions(env: NodeJS.ProcessEnv = process.env): SessionCookieOptions {
  return { httpOnly: true, sameSite: "lax", secure: isProd(env), path: "/", maxAge: SESSION_TTL_SECONDS };
}

export async function issueSession(jar: CookieJar, store: AuthStore, user: AuthUser, now: number = Date.now()): Promise<void> {
  const previous = jar.get(SESSION_HANDLE_COOKIE)?.value;
  if (previous) await store.revokeSession(previous);

  const exp = Math.floor(now / 1000) + SESSION_TTL_SECONDS;
  const token = await store.createSession(user.id, user.tenantId, new Date(exp * 1000));
  const session: Session = { userId: user.id, tenantId: user.tenantId, email: user.email, exp };
  const opts = sessionCookieOptions();
  jar.set(SESSION_COOKIE, encodeSession(session), opts);
  jar.set(SESSION_HANDLE_COOKIE, token, opts);
}
