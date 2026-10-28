// lib/http/limit.ts
// Per-caller throttles for the routes that cost something each time they are called.
//
// Before WP-QA03 only /live and /api/model were throttled. Login ran an unlimited number of
// password guesses (each one a synchronous scrypt, so also a CPU drain), register made accounts
// without limit, and POST /api/run started a register lookup, a document fetch and possibly a
// paid scan read per call with nothing between a script and the spend. The limits below are
// generous for a person and tight for a script; the numbers are Cam's to change.

import { NextResponse } from "next/server";
import { clientIp, getRateLimiter, type HeaderReader } from "../ratelimit/ratelimit";

export interface Limit {
  // The bucket, e.g. "login:ip". The caller's id is appended.
  bucket: string;
  id: string;
  limit: number;
  windowSeconds: number;
}

export const LIMITS = {
  loginPerIp: { limit: 20, windowSeconds: 5 * 60 },
  loginPerEmail: { limit: 10, windowSeconds: 15 * 60 },
  registerPerIp: { limit: 10, windowSeconds: 60 * 60 },
  runPerTenant: { limit: 20, windowSeconds: 10 * 60 },
  runPerIp: { limit: 40, windowSeconds: 10 * 60 },
  // A name lookup (GET /api/resolve/candidates) costs up to 12 register calls and no run.
  resolvePerTenant: { limit: 30, windowSeconds: 10 * 60 },
  resolvePerIp: { limit: 60, windowSeconds: 10 * 60 },
} as const;

// Check every limit (each one counts this request) and answer 429 if any is spent. Null means
// go ahead. Every limit is checked, not just the first that fails, so a caller rotating one key
// still spends the other.
export async function throttle(limits: Limit[]): Promise<Response | null> {
  const limiter = getRateLimiter();
  let blocked = false;
  let retry = 1;
  for (const l of limits) {
    const r = await limiter.check(`${l.bucket}:${l.id}`, l.limit, l.windowSeconds);
    if (!r.ok) {
      blocked = true;
      retry = Math.max(retry, r.resetSeconds);
    }
  }
  if (!blocked) return null;
  return NextResponse.json(
    { error: "Too many requests. Please retry shortly.", retryAfterSeconds: retry },
    { status: 429, headers: { "Retry-After": String(retry), "Cache-Control": "no-store" } },
  );
}

export function ipOf(req: { headers: HeaderReader }): string {
  return clientIp(req.headers);
}
