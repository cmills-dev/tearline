// lib/auth/registration.ts
// Who may register, and into which tenant (WP-DS05, DSD-12).
//
// In production registration needs an invite. isProd() decides production (NODE_ENV or
// VERCEL_ENV). REGISTRATION_MODE=invite turns the same rule on anywhere else, for a preview
// that faces the internet. Nothing turns it off in production.
//
// With an invite, the new user joins the invite's tenant. Without one, and only outside invite
// mode, registration works as before: a fresh tenant per account.
//
// The route keeps input checks, the throttle and the session cookies. This module holds the
// decision, so a test can drive it without a request context.

import { randomUUID } from "crypto";
import { isProd } from "../config/prodGuard";
import { hashPassword } from "./crypto";
import type { AuthStore, AuthUser } from "./store";

export type RegistrationMode = "invite" | "open";

export function registrationMode(env: NodeJS.ProcessEnv = process.env): RegistrationMode {
  if (isProd(env)) return "invite";
  return env.REGISTRATION_MODE === "invite" ? "invite" : "open";
}

export const INVITE_REQUIRED_MESSAGE =
  "Registration is by invitation only. If your desk has invited you, please use the link in your invitation email. If you would like access, get in touch and we will set you up.";

export const INVITE_INVALID_MESSAGE =
  "This invitation cannot be used. It may have expired, been used already, or been sent to a different email address. Please ask the person who invited you for a new link.";

export const ACCOUNT_EXISTS_MESSAGE = "An account with that email already exists.";

export type RegistrationOutcome =
  | { ok: true; user: AuthUser }
  | { ok: false; status: 403 | 409; error: string; code: "invite_required" | "invite_invalid" | "exists" };

export interface RegistrationInput {
  email: string; // already trimmed and lower-cased by the route
  password: string; // already length-checked by the route
  invite?: string; // the token from the invite link
}

export async function registerUser(
  input: RegistrationInput,
  store: AuthStore,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): Promise<RegistrationOutcome> {
  const token = (input.invite ?? "").trim();

  if (token) {
    // An invite is honoured in either mode, so a preview can test the invite path.
    const r = await store.redeemInvite(token, input.email, hashPassword(input.password), now);
    if (r.ok) return { ok: true, user: r.user };
    if (r.reason === "exists") return { ok: false, status: 409, error: ACCOUNT_EXISTS_MESSAGE, code: "exists" };
    return { ok: false, status: 403, error: INVITE_INVALID_MESSAGE, code: "invite_invalid" };
  }

  // Refused before any lookup, so an uninvited caller cannot learn which emails have accounts.
  if (registrationMode(env) === "invite") {
    return { ok: false, status: 403, error: INVITE_REQUIRED_MESSAGE, code: "invite_required" };
  }

  if (await store.findUserByEmail(input.email)) {
    return { ok: false, status: 409, error: ACCOUNT_EXISTS_MESSAGE, code: "exists" };
  }
  try {
    const user = await store.createUser(input.email, hashPassword(input.password), randomUUID());
    return { ok: true, user };
  } catch {
    // Two concurrent registrations for the same email both clear the check above; the store's
    // unique constraint then rejects the second. Map it to the same 409, never a 500.
    return { ok: false, status: 409, error: ACCOUNT_EXISTS_MESSAGE, code: "exists" };
  }
}
