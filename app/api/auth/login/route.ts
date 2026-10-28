// app/api/auth/login/route.ts
// Login: verify the password against the stored scrypt hash, then issue a signed session
// bound to the user's tenant. Failures are deliberately generic (no distinction between an
// unknown email and a wrong password) so the endpoint does not confirm which emails exist.
// The password and hash are never logged or echoed.
//
// WP-DS05 (DSD-12): ten failed logins for one email from one address in a minute, and the next
// attempt answers 429 with Retry-After before any password check (lib/auth/loginLimit.ts).

import { NextResponse } from "next/server";
import { readJsonObject } from "@/lib/http/body";
import { ipOf, LIMITS, throttle } from "@/lib/http/limit";
import { cookies } from "next/headers";
import { verifyPassword, hashPassword } from "@/lib/auth/crypto";
import { getAuthStore } from "@/lib/auth/store";
import { issueSession } from "@/lib/auth/issue";
import { getRateLimiter } from "@/lib/ratelimit/ratelimit";
import { loginBlockedFor, recordLoginFailure, tooManyLogins } from "@/lib/auth/loginLimit";

export const dynamic = "force-dynamic";

const MAX_PASSWORD = 1024; // scrypt is synchronous; cap the input so a huge one cannot stall the loop
// A constant dummy hash so an unknown email pays the SAME scrypt cost as a known one: without it
// the "user not found" path returns early and leaks, by timing, which emails are registered.
const DUMMY_HASH = hashPassword("timing-equaliser-not-a-real-password");

export async function POST(req: Request) {
  const body = (await readJsonObject(req)) as { email?: string; password?: string };
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");

  if (!email || !password) {
    return NextResponse.json({ error: "Email and password are required." }, { status: 400 });
  }
  const ip = ipOf(req);
  const limiter = getRateLimiter();
  // The failed-login gate looks first and counts nothing, so a blocked caller spends no more.
  const blockedFor = await loginBlockedFor(limiter, email, ip);
  if (blockedFor !== null) return tooManyLogins(blockedFor);
  // Before any scrypt work: per IP against spraying, per email against guessing one account.
  const limited = await throttle([
    { bucket: "login:ip", id: ip, ...LIMITS.loginPerIp },
    { bucket: "login:email", id: email.slice(0, 320), ...LIMITS.loginPerEmail },
  ]);
  if (limited) return limited;
  if (password.length > MAX_PASSWORD) {
    const over = await recordLoginFailure(limiter, email, ip);
    if (over !== null) return tooManyLogins(over);
    return NextResponse.json({ error: "Incorrect email or password." }, { status: 401 });
  }

  const store = getAuthStore();
  const user = await store.findUserByEmail(email);
  // Always run one verify (against the real hash, or a dummy) so response time does not reveal
  // whether the email exists. The generic 401 does not distinguish unknown email from wrong password.
  const passwordOk = verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !passwordOk) {
    const over = await recordLoginFailure(limiter, email, ip);
    if (over !== null) return tooManyLogins(over);
    return NextResponse.json({ error: "Incorrect email or password." }, { status: 401 });
  }

  // Revokes any session handle this browser already holds, and sets Secure by isProd().
  await issueSession(await cookies(), store, user);

  // The tenant id is not echoed. Nothing in the app reads it, and in the anonymous demo mode a
  // tenant id sent back as the `tid` cookie opens that workspace (WP-QA03 F6, D3).
  return NextResponse.json({ ok: true, email: user.email });
}
