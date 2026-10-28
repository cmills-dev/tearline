// test/auth.test.ts
// Auth primitives (no DB): scrypt password hashing, the HMAC-signed cookie envelope, and the
// session encode/decode with tamper detection and expiry. Full RLS enforcement is DB-gated
// (db/migrations/0002_auth.sql, 0003_rls.sql) and not exercised here.

import { suite, test, assert, assertEqual } from "./harness";
import { hashPassword, verifyPassword, sign, verify } from "../lib/auth/crypto";
import { encodeSession, decodeSession, type Session } from "../lib/auth/session";

suite("auth / password hashing");

test("a password verifies against its own scrypt hash and rejects a wrong one", () => {
  const h = hashPassword("correct horse battery staple");
  assert(verifyPassword("correct horse battery staple", h), "correct password verifies");
  assert(!verifyPassword("wrong password", h), "wrong password rejected");
  assert(h.startsWith("scrypt$"), "salted scrypt format");
});

suite("auth / signed session");

const secret = "test-secret";

test("HMAC sign/verify round-trips and rejects tampering", () => {
  const t = sign("hello", secret);
  assertEqual(verify(t, secret), "hello", "round-trips");
  assertEqual(verify(t, "other-secret"), null, "wrong secret rejected");
  assertEqual(verify(t.slice(0, -2) + "xx", secret), null, "tampered signature rejected");
});

test("session encodes, decodes, and enforces expiry + tamper", () => {
  const s: Session = { userId: "u1", tenantId: "t1", email: "a@b.co", exp: Math.floor(Date.now() / 1000) + 3600 };
  const tok = encodeSession(s, secret);
  const back = decodeSession(tok, secret);
  assert(!!back && back.tenantId === "t1" && back.userId === "u1", "decodes to the same session");

  const expired: Session = { ...s, exp: Math.floor(Date.now() / 1000) - 10 };
  assertEqual(decodeSession(encodeSession(expired, secret), secret), null, "expired session rejected");
  assertEqual(decodeSession(tok, "wrong"), null, "forged session (wrong secret) rejected");
});
