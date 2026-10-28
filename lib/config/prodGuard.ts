// lib/config/prodGuard.ts
// The production-readiness guard: a pure, env-reading check that fails fast (in production)
// or warns loudly (in dev) when a security-critical setting is missing or left at an insecure
// default, instead of silently degrading. It NEVER reads or returns a secret VALUE, only the
// NAMES of the variables that are missing or weak, so it is safe to surface over an API or a log.
//
// The requirements consolidate checks that already live scattered across the code, so nothing is
// duplicated here in a way that could drift:
//   - AUTH_SECRET      - lib/auth/session.ts refuses a missing/default secret in production (the
//                        signing key the whole MNPI wall stands on). Dev fallback:
//                        "dev-insecure-secret-set-AUTH_SECRET".
//   - AUTH_REQUIRED    - lib/tenant.ts falls back to an anonymous per-browser tenant unless this
//                        is "1"; a real multi-tenant deployment must set it.
//   - SHARED_HASH_PEPPER - lib/clientspec/sharedHash.ts keys the one-way tenant-id hash of the
//                        shared plane; dev fallback "dev-shared-pepper" is enumerable.
//   - DATABASE_URL / POSTGRES_URL - lib/store/postgres.ts durable store; without it the store is
//                        per-process in-memory and does not survive a restart.
//   - CRON_SECRET (warn) - app/api/cron/monitor/route.ts leaves the monitor sweep open to any
//                        caller carrying Vercel's cron header when this is unset.
//   - Upstash KV (warn) - lib/cache/cache.ts / rate limiter are per-instance only without it.

// The known dev fallback for AUTH_SECRET (mirrors lib/auth/session.ts). Rejected even though it
// is long, so a copied dev value cannot pass the length gate in production.
const AUTH_SECRET_DEV_FALLBACK = "dev-insecure-secret-set-AUTH_SECRET";

// The dev fallback pepper (mirrors lib/clientspec/sharedHash.ts).
const SHARED_PEPPER_DEV_FALLBACK = "dev-shared-pepper";

// Obvious weak/placeholder AUTH_SECRET values, rejected regardless of length.
const WEAK_SECRETS = new Set(["", "dev", "changeme", "secret", AUTH_SECRET_DEV_FALLBACK]);

// The minimum length a real AUTH_SECRET must reach. Anything shorter is treated as weak.
const MIN_SECRET_LENGTH = 24;

export interface Readiness {
  ok: boolean;
  missing: string[];
  warnings: string[];
}

// True when we are running in a genuine production environment. VERCEL_ENV is checked as well as
// NODE_ENV so a Vercel production deployment is caught even if NODE_ENV is not stamped.
export function isProd(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "production" || env.VERCEL_ENV === "production";
}

// Whether a value looks like a strong, non-default secret: present, not an obvious placeholder,
// and long enough not to be trivially guessed.
function isStrongSecret(value: string | undefined): boolean {
  if (!value) return false;
  if (WEAK_SECRETS.has(value)) return false;
  return value.length >= MIN_SECRET_LENGTH;
}

// Reports which security-critical variables are missing (fatal) and which are merely advisable
// (warnings). Reads only names of variables, never returns their values.
export function productionReadiness(env: NodeJS.ProcessEnv = process.env): Readiness {
  const missing: string[] = [];
  const warnings: string[] = [];

  // Warnings apply in every environment: they flag a degraded-but-running posture.
  const hasUpstash = Boolean(env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL);
  if (!hasUpstash) {
    warnings.push("no Upstash KV configured (rate-limit and Companies House budget are per-instance only)");
  }

  // Outside production the app is allowed to run on its dev fallbacks, so nothing is fatal.
  if (!isProd(env)) {
    return { ok: true, missing, warnings };
  }

  // Production requirements. Each pushes only the variable NAME on failure, never the value.
  if (!isStrongSecret(env.AUTH_SECRET)) {
    missing.push("AUTH_SECRET");
  }
  if (env.AUTH_REQUIRED !== "1") {
    missing.push("AUTH_REQUIRED");
  }
  if (!env.SHARED_HASH_PEPPER || env.SHARED_HASH_PEPPER === SHARED_PEPPER_DEV_FALLBACK) {
    missing.push("SHARED_HASH_PEPPER");
  }
  if (!env.APP_DATABASE_URL && !env.DATABASE_URL && !env.POSTGRES_URL) {
    missing.push("DATABASE_URL");
  }
  // Required in production so the monitor cron is not triggerable by a spoofed Vercel cron header,
  // and shared-dictionary promotion is not open to any signed-in tenant (a Sybil-poisoning surface).
  if (!env.CRON_SECRET) {
    missing.push("CRON_SECRET");
  }
  if (!env.SHARED_ADMIN_SECRET) {
    missing.push("SHARED_ADMIN_SECRET");
  }

  return { ok: missing.length === 0, missing, warnings };
}

// Throws in production when a required variable is missing or weak, listing the NAMES only. In
// any non-production environment, or when everything is satisfied, it returns without throwing.
export function assertProductionReady(env: NodeJS.ProcessEnv = process.env): void {
  if (!isProd(env)) return;
  const r = productionReadiness(env);
  if (r.ok) return;
  throw new Error(
    `Production readiness check failed: set ${r.missing.join(", ")} to a strong, non-default value before deploying.`,
  );
}
