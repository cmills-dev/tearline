// test/authFlow.test.ts
// The auth flow over the in-memory store (no DB): registration creates a user under a fresh
// tenant, the password verifies against its stored scrypt hash, a session loads back the
// right tenant, and revocation (logout) makes the session unresolvable. Async because the
// store interface is promise-based, so it registers its cases after the flow has run, in the
// same style as test/onboarding.test.ts.

import { randomUUID } from "crypto";
import { suite, test, assert, assertEqual } from "./harness";
import { hashPassword, verifyPassword } from "../lib/auth/crypto";
import { InMemoryAuthStore } from "../lib/auth/store";

suite("auth / flow (in-memory store)");

export async function registerAuthFlowTests(): Promise<void> {
  const store = new InMemoryAuthStore();
  const email = "Analyst@Example.com"; // mixed case to confirm normalisation
  const tenantId = randomUUID();

  const created = await store.createUser(email, hashPassword("correct horse battery"), tenantId);
  const found = await store.findUserByEmail("analyst@example.com");

  const token = await store.createSession(created.id, created.tenantId, new Date(Date.now() + 3_600_000));
  const loaded = await store.loadSession(token);

  await store.revokeSession(token);
  const afterRevoke = await store.loadSession(token);

  // A duplicate registration must be refused.
  let dupThrew = false;
  try {
    await store.createUser(email, hashPassword("anything else"), randomUUID());
  } catch {
    dupThrew = true;
  }

  // A missing user resolves to null (so login cannot leak which emails exist).
  const missing = await store.findUserByEmail("nobody@example.com");

  test("registration creates a user under a fresh tenant, email normalised", () => {
    assertEqual(created.tenantId, tenantId, "user carries the tenant it was created with");
    assertEqual(created.email, "analyst@example.com", "email lower-cased on write");
    assert(!!found, "user is findable by email, case-insensitively");
    assertEqual(found!.id, created.id, "same user returned");
    assertEqual(missing, null, "unknown email resolves to null");
  });

  test("login verifies against the stored scrypt hash and rejects a wrong password", () => {
    assert(!!found, "user present");
    assert(verifyPassword("correct horse battery", found!.passwordHash), "correct password verifies");
    assert(!verifyPassword("wrong password", found!.passwordHash), "wrong password rejected");
    assert(found!.passwordHash.startsWith("scrypt$"), "stored value is a salted scrypt hash, not plaintext");
  });

  test("a loaded session yields the right user and tenant", () => {
    assert(!!loaded, "session loads back");
    assertEqual(loaded!.tenantId, tenantId, "session carries the user's tenant");
    assertEqual(loaded!.userId, created.id, "session carries the user id");
  });

  test("revocation (logout) makes the session unresolvable", () => {
    assertEqual(afterRevoke, null, "revoked session no longer loads");
  });

  test("a duplicate registration is refused", () => {
    assert(dupThrew, "second createUser for the same email throws");
  });
}
