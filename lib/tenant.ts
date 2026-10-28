// lib/tenant.ts
// Resolves the current tenant from the request - the single choke point the MNPI wall stands
// on. A verified session cookie binds the tenant to a signed-in user; absent a session, we
// fall back to the anonymous per-browser tenant so the unauthenticated demo keeps working.
// Set AUTH_REQUIRED=1 to remove the anonymous fallback (real multi-tenant deployments).
// The anonymous `tid` cookie is signed and its ids carry the `anon_` prefix; the parsing and the
// signature check live in lib/auth/tenantCookie.ts, where they are tested (WP-QA05, QA03 D3).
// Every store call already takes an explicit tenantId, so nothing downstream changes.

import { cookies } from "next/headers";
import { decodeSession, SESSION_COOKIE, type Session } from "./auth/session";
import { getAuthStore, SESSION_HANDLE_COOKIE } from "./auth/store";
import { databaseUrl } from "./store/postgres";
import { resolveTenantId, TENANT_COOKIE } from "./auth/tenantCookie";

export { TENANT_COOKIE };

export async function getSession(): Promise<Session | null> {
  const jar = await cookies();
  const session = decodeSession(jar.get(SESSION_COOKIE)?.value);
  if (!session) return null;
  // The signed envelope proves non-forgery, but on a durable deployment it must not outlive a
  // logout: the server-side session row is authoritative and revocation deletes it. So when a
  // database is configured, require the handle cookie to still resolve to a live session bound
  // to the same tenant. (In the in-memory demo the row lives only in this process, and each
  // serverless instance has its own memory, so we trust the envelope there and document it.)
  if (databaseUrl()) {
    const handle = jar.get(SESSION_HANDLE_COOKIE)?.value;
    const live = handle ? await getAuthStore().loadSession(handle) : null;
    if (!live || live.tenantId !== session.tenantId) return null; // revoked, expired, or absent
  }
  return session;
}

export async function getTenantId(): Promise<string> {
  const session = await getSession();
  const authRequired = process.env.AUTH_REQUIRED === "1"; // no anonymous access in enforced mode
  const tidCookie = session || authRequired ? undefined : (await cookies()).get(TENANT_COOKIE)?.value;
  return resolveTenantId({ session, authRequired, tidCookie });
}
