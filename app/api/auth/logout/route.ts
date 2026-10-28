// app/api/auth/logout/route.ts
// Logout: revoke the server-side session row (so a leaked cookie cannot be replayed) and
// clear both auth cookies. Revocation is what the signed envelope alone cannot provide.

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { getAuthStore, SESSION_HANDLE_COOKIE } from "@/lib/auth/store";

export const dynamic = "force-dynamic";

export async function POST() {
  const jar = await cookies();
  const handle = jar.get(SESSION_HANDLE_COOKIE)?.value;
  if (handle) {
    await getAuthStore().revokeSession(handle);
  }
  jar.delete(SESSION_COOKIE);
  jar.delete(SESSION_HANDLE_COOKIE);
  return NextResponse.json({ ok: true });
}
