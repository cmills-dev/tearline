// test/prodGuard.test.ts
// Exercises the production-readiness guard (lib/config/prodGuard.ts): the required-vs-warning
// split, that each missing/weak required var is named (and only the name, never a value), and
// that a non-prod env is always ok. productionReadiness is pure and takes an explicit env, so
// no process.env mutation is needed; assertions read values captured during async setup, which
// mirrors test/hosting.test.ts.

import { productionReadiness, assertProductionReady, type Readiness } from "../lib/config/prodGuard";
import { suite, test, assert, assertEqual } from "./harness";

// A complete, healthy production environment. Individual cases clone and break one field.
function fullProdEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    AUTH_SECRET: "a-strong-secret-value-well-over-24-chars",
    AUTH_REQUIRED: "1",
    SHARED_HASH_PEPPER: "a-real-non-default-pepper-value",
    DATABASE_URL: "postgres://user:pass@host:5432/db",
    CRON_SECRET: "a-cron-secret",
    SHARED_ADMIN_SECRET: "a-shared-admin-secret",
    KV_REST_API_URL: "https://kv.example.com",
  } as NodeJS.ProcessEnv;
}

// --- Captured during setup ---------------------------------------------------
let full: Readiness;
let missingAuthSecret: Readiness;
let weakAuthSecret: Readiness;
let authNotRequired: Readiness;
let defaultPepper: Readiness;
let noDatabase: Readiness;
let postgresUrlAccepted: Readiness;
let nonProd: Readiness;
let cronUnsetProd: Readiness;
let assertThrewOnMissing = false;
let assertSilentWhenReady = true;
let assertSilentInDev = true;

export async function registerProdGuardTests(): Promise<void> {
  full = productionReadiness(fullProdEnv());

  const noSecret = fullProdEnv();
  delete noSecret.AUTH_SECRET;
  missingAuthSecret = productionReadiness(noSecret);

  const weak = fullProdEnv();
  weak.AUTH_SECRET = "changeme"; // a known placeholder, and under the length gate
  weakAuthSecret = productionReadiness(weak);

  const noEnforce = fullProdEnv();
  noEnforce.AUTH_REQUIRED = "0";
  authNotRequired = productionReadiness(noEnforce);

  const devPepper = fullProdEnv();
  devPepper.SHARED_HASH_PEPPER = "dev-shared-pepper"; // the dev fallback
  defaultPepper = productionReadiness(devPepper);

  const noDb = fullProdEnv();
  delete noDb.DATABASE_URL;
  noDatabase = productionReadiness(noDb);

  const pgOnly = fullProdEnv();
  delete pgOnly.DATABASE_URL;
  pgOnly.POSTGRES_URL = "postgres://user:pass@host:5432/db"; // a Vercel-injected alias satisfies it
  postgresUrlAccepted = productionReadiness(pgOnly);

  // Non-prod: even a bare env is ok (dev fallbacks are allowed).
  nonProd = productionReadiness({ NODE_ENV: "development" } as NodeJS.ProcessEnv);

  const noCron = fullProdEnv();
  delete noCron.CRON_SECRET;
  cronUnsetProd = productionReadiness(noCron);

  // assertProductionReady behaviour.
  try {
    assertProductionReady(noSecret);
  } catch {
    assertThrewOnMissing = true;
  }
  try {
    assertProductionReady(fullProdEnv());
  } catch {
    assertSilentWhenReady = false;
  }
  try {
    assertProductionReady({ NODE_ENV: "development" } as NodeJS.ProcessEnv);
  } catch {
    assertSilentInDev = false;
  }

  registerCases();
}

function registerCases(): void {
  suite("prodGuard / full production env");

  test("a complete prod env is ok with nothing missing", () => {
    assertEqual(full.ok, true, "full prod env passes");
    assertEqual(full.missing.length, 0, "nothing missing");
    assertEqual(full.warnings.length, 0, "no warnings when cron + KV are set");
  });

  suite("prodGuard / required vars (fatal when missing/weak)");

  test("missing AUTH_SECRET is fatal and named", () => {
    assertEqual(missingAuthSecret.ok, false, "not ok without AUTH_SECRET");
    assert(missingAuthSecret.missing.includes("AUTH_SECRET"), "AUTH_SECRET named as missing");
  });

  test("a weak AUTH_SECRET is treated as missing", () => {
    assertEqual(weakAuthSecret.ok, false, "not ok with a weak AUTH_SECRET");
    assert(weakAuthSecret.missing.includes("AUTH_SECRET"), "weak AUTH_SECRET named");
  });

  test("AUTH_REQUIRED not '1' is fatal and named", () => {
    assertEqual(authNotRequired.ok, false, "not ok without enforced auth");
    assert(authNotRequired.missing.includes("AUTH_REQUIRED"), "AUTH_REQUIRED named");
  });

  test("the default SHARED_HASH_PEPPER is fatal and named", () => {
    assertEqual(defaultPepper.ok, false, "not ok on the dev pepper");
    assert(defaultPepper.missing.includes("SHARED_HASH_PEPPER"), "SHARED_HASH_PEPPER named");
  });

  test("no durable store (no DATABASE_URL / POSTGRES_URL) is fatal and named", () => {
    assertEqual(noDatabase.ok, false, "not ok without a durable store");
    assert(noDatabase.missing.includes("DATABASE_URL"), "DATABASE_URL named");
  });

  test("POSTGRES_URL alone satisfies the durable-store requirement", () => {
    assertEqual(postgresUrlAccepted.ok, true, "POSTGRES_URL counts as a durable store");
    assert(!postgresUrlAccepted.missing.includes("DATABASE_URL"), "DATABASE_URL not flagged");
  });

  test("readiness never leaks a value, only names", () => {
    // Every missing entry is a bare variable name (no '=' and no secret substring).
    for (const name of missingAuthSecret.missing) {
      assert(!name.includes("="), `missing entry '${name}' is a name, not an assignment`);
    }
  });

  suite("prodGuard / required secrets");

  test("CRON_SECRET unset in prod is fatal (the cron is otherwise spoofable)", () => {
    assert(cronUnsetProd.missing.includes("CRON_SECRET"), "CRON_SECRET is required in production");
    assertEqual(cronUnsetProd.ok, false, "a prod env without CRON_SECRET is not ready");
  });

  test("SHARED_ADMIN_SECRET unset in prod is fatal (promotion is otherwise open)", () => {
    const env = fullProdEnv();
    delete env.SHARED_ADMIN_SECRET;
    const r = productionReadiness(env);
    assert(r.missing.includes("SHARED_ADMIN_SECRET"), "SHARED_ADMIN_SECRET is required in production");
  });

  suite("prodGuard / non-production");

  test("a non-prod env is ok regardless of secrets", () => {
    assertEqual(nonProd.ok, true, "dev is always ok");
    assertEqual(nonProd.missing.length, 0, "nothing fatal in dev");
  });

  suite("prodGuard / assertProductionReady");

  test("throws in prod when a required var is missing", () => {
    assert(assertThrewOnMissing, "assertProductionReady throws on a missing secret in prod");
  });

  test("does not throw when prod is fully ready", () => {
    assert(assertSilentWhenReady, "assertProductionReady is silent on a healthy prod env");
  });

  test("does not throw outside production", () => {
    assert(assertSilentInDev, "assertProductionReady is a no-op in dev");
  });
}
