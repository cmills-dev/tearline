// lib/http/requestGuard.ts (WP-QA06 S4, S5)
// Two checks the middleware runs on every API request before any route sees it.
//
// 1. Cross-origin writes. A POST, PUT, PATCH or DELETE whose Origin names another host is
//    refused. SameSite=Lax already keeps the session cookie off a cross-site POST, but login
//    needs no cookie, so without this another site could sign a visitor into the attacker's
//    desk (login CSRF), and a same-site attacker (a sibling subdomain) could write with the
//    visitor's session. Browsers always send Origin on a cross-origin POST. A request with no
//    Origin at all (curl, the smoke scripts, the Vercel cron) is let through unless the browser
//    marks it cross-site with Sec-Fetch-Site.
// 2. Size. A body that declares more than MAX_BODY_BYTES is refused with 413 before it is read.
//    readJsonObject caps the bytes it reads as well, for a body that declares no length.

export const MAX_BODY_BYTES = 1024 * 1024;

export interface GuardHeaders {
  get(name: string): string | null;
}

export interface GuardVerdict {
  status: 403 | 413;
  error: string;
}

const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function requestHost(headers: GuardHeaders): string | null {
  const forwarded = headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  return (forwarded || headers.get("host") || "").toLowerCase() || null;
}

export function guardApiRequest(method: string, pathname: string, headers: GuardHeaders): GuardVerdict | null {
  if (!pathname.startsWith("/api/")) return null;
  const m = method.toUpperCase();

  const declared = Number(headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { status: 413, error: "That request is too large." };
  }

  if (!WRITES.has(m)) return null;
  const origin = headers.get("origin");
  if (origin !== null) {
    let originHost: string | null = null;
    try {
      originHost = origin === "null" ? null : new URL(origin).host.toLowerCase();
    } catch {
      originHost = null;
    }
    const host = requestHost(headers);
    if (!originHost || !host || originHost !== host) {
      return { status: 403, error: "Cross-origin request refused." };
    }
    return null;
  }
  if ((headers.get("sec-fetch-site") ?? "").toLowerCase() === "cross-site") {
    return { status: 403, error: "Cross-origin request refused." };
  }
  return null;
}
