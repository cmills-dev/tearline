// app/api/auth/register/route.ts
// Registration: create a user, then issue a signed session. The password is hashed with scrypt
// before it touches the store; the plaintext and the hash are never logged or echoed.
//
// WP-DS05 (DSD-12): in production registration needs an invite, sent as `invite` (the token in
// the invite link). A valid invite puts the user in the invite's tenant. Without one, production
// answers 403 with a polite refusal. Outside production, and without REGISTRATION_MODE=invite,
// an uninvited registration still gets a fresh tenant (crypto.randomUUID), as before. The
// decision lives in lib/auth/registration.ts.

import { NextResponse } from "next/server";
import { readJsonObject } from "@/lib/http/body";
import { ipOf, LIMITS, throttle } from "@/lib/http/limit";
import { cookies } from "next/headers";
import { getAuthStore } from "@/lib/auth/store";
import { issueSession } from "@/lib/auth/issue";
import { registerUser } from "@/lib/auth/registration";

export const dynamic = "force-dynamic";


export async function POST(req: Request) {
  const body = (await readJsonObject(req)) as { email?: string; password?: string; invite?: unknown };
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");

  if (!email || !password) {
    return NextResponse.json({ error: "Email and password are required." }, { status: 400 });
  }
  if (!email.includes("@")) {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }
  if (password.length < 8) {
    return NextResponse.json({ error: "Password must be at least 8 characters." }, { status: 400 });
  }
  if (password.length > 1024) {
    return NextResponse.json({ error: "Password is too long." }, { status: 400 });
  }

  const limited = await throttle([{ bucket: "register:ip", id: ipOf(req), ...LIMITS.registerPerIp }]);
  if (limited) return limited;

  const invite = typeof body.invite === "string" ? body.invite.slice(0, 256) : "";

  const store = getAuthStore();
  const outcome = await registerUser({ email, password, invite }, store);
  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.error, code: outcome.code }, { status: outcome.status });
  }
  const user = outcome.user;

  await issueSession(await cookies(), store, user);

  // The tenant id is not echoed. Nothing in the app reads it, and in the anonymous demo mode a
  // tenant id sent back as the `tid` cookie opens that workspace (WP-QA03 F6, D3).
  return NextResponse.json({ ok: true, email: user.email });
}
