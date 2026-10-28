// lib/auth/loginLimit.ts
// The failed-login gate (WP-DS05, DSD-12). Ten failed logins for one email from one address in
// a minute are allowed. The eleventh attempt gets 429 with Retry-After, whatever the password,
// and before any scrypt work. Only failures count, so a person who signs in and out is never
// held back by it.
//
// This sits beside the per-IP and per-email throttles in lib/http/limit.ts (WP-QA03), which count
// every attempt over longer windows. Those stay. When more than one limit is spent the answer
// carries the longest wait.

import { NextResponse } from "next/server";
import type { RateLimiter } from "../ratelimit/ratelimit";

export const LOGIN_FAILURES = { limit: 10, windowSeconds: 60 } as const;

export function loginFailureKey(email: string, ip: string): string {
  return `login:fail:${email.toLowerCase().slice(0, 320)}:${ip.slice(0, 64)}`;
}

// Seconds to wait if this email and address have spent their failures, else null.
export async function loginBlockedFor(limiter: RateLimiter, email: string, ip: string): Promise<number | null> {
  const { count, resetSeconds } = await limiter.peek(loginFailureKey(email, ip));
  if (count >= LOGIN_FAILURES.limit) return Math.max(1, resetSeconds);
  return null;
}

// Count one failure. Returns seconds to wait if this failure went over the limit (two requests
// racing past the gate), else null.
export async function recordLoginFailure(limiter: RateLimiter, email: string, ip: string): Promise<number | null> {
  const r = await limiter.check(loginFailureKey(email, ip), LOGIN_FAILURES.limit, LOGIN_FAILURES.windowSeconds);
  return r.ok ? null : Math.max(1, r.resetSeconds);
}

export function tooManyLogins(retryAfterSeconds: number): Response {
  const retry = Math.max(1, Math.ceil(retryAfterSeconds));
  return NextResponse.json(
    { error: "Too many sign-in attempts. Please wait a minute and try again.", retryAfterSeconds: retry },
    { status: 429, headers: { "Retry-After": String(retry), "Cache-Control": "no-store" } },
  );
}
