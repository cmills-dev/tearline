// instrumentation.ts
// Next.js calls register() once on server boot (before any request is served). We use it as the
// fail-fast point for the production-readiness guard: in production a genuine missing or weak
// security secret SHOULD throw and stop the boot, rather than let the app come up silently
// degraded. In dev we only warn, and we wrap everything so a bug in the guard itself can never
// brick a local boot.

export async function register(): Promise<void> {
  // `next build` runs register() with NODE_ENV=production during the build phase, where the runtime
  // secrets are legitimately absent. Only enforce at actual server boot, never during the build, or
  // every build would fail for want of production secrets it does not need yet.
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const { assertProductionReady, isProd, productionReadiness } = await import("./lib/config/prodGuard");
  if (isProd()) {
    // In production, let a genuine missing-secret error propagate: the boot must fail loudly.
    assertProductionReady();
    return;
  }
  // In dev, be defensive: a guard bug must not stop the local server from starting.
  try {
    const r = productionReadiness();
    if (r.warnings.length) {
      console.warn("[prod-guard] warnings:", r.warnings.join(", "));
    }
  } catch (err) {
    console.warn("[prod-guard] readiness check skipped:", (err as Error).message);
  }
}
