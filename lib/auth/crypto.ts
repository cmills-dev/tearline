// lib/auth/crypto.ts
// Auth primitives with ZERO new dependencies (node:crypto): scrypt password hashing and an
// HMAC-signed, tamper-evident session token. The session is authoritative server-side (the
// token hash is looked up in a DB-backed, revocable session table); the signature lets cheap
// middleware reject a forged cookie without a DB round-trip.

import { scryptSync, randomBytes, timingSafeEqual, createHmac, createHash } from "crypto";

const KEYLEN = 32;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, KEYLEN);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  const derived = scryptSync(password, salt, expected.length || KEYLEN);
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

// A random, URL-safe session token; only its SHA-like HMAC is stored server-side.
export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}
export function tokenFingerprint(token: string, secret: string): string {
  return createHmac("sha256", secret).update(token).digest("hex");
}

// An invite token (WP-DS05). 32 random bytes, URL-safe, sent once in the invite link. Only its
// SHA-256 is stored. A plain hash is enough for 256 random bits, and it keeps the admin script
// independent of AUTH_SECRET: an invite written from a laptop must match the app's lookup.
export function newInviteToken(): string {
  return randomBytes(32).toString("base64url");
}
export function inviteTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// HMAC-sign an arbitrary payload string (used for the cookie envelope).
export function sign(payload: string, secret: string): string {
  const body = Buffer.from(payload, "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verify(token: string, secret: string): string | null {
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return Buffer.from(body, "base64url").toString("utf8");
}
