// lib/ratelimit/ratelimit.ts
// Fixed-window rate limiting, on the same seam as the cache: an in-memory default that
// works per-process, and a shared Upstash / Vercel KV backend (INCR + EXPIRE over the
// REST API) that makes the limit correct across serverless instances. Selected purely by
// the presence of the Upstash env, so the flip is env-only.
//
// Two things stand on this:
//   1. check(id, limit, windowSeconds) - per-IP throttles on the API route and the /live
//      search action, so one client cannot exhaust the instance.
//   2. assertChBudget() - a GLOBAL guard around the Companies House calls so we never
//      approach CH's real ceiling of 600 requests / 5 minutes.

import { upstashConfig } from "../cache/cache";

export interface RateLimitResult {
  ok: boolean;
  remaining: number; // requests left in the current window (never negative)
  resetSeconds: number; // seconds until the window resets and the count clears
  degraded?: boolean; // true when the SHARED counter was unreachable and this call failed open
}

export interface RateLimiter {
  check(id: string, limit: number, windowSeconds: number): Promise<RateLimitResult>;
  // Read the id's count in its current window without adding to it (WP-DS05: the failed-login
  // gate counts failures only, so it must look before it counts). 0 when there is no window.
  peek(id: string): Promise<{ count: number; resetSeconds: number }>;
}

// ---------------------------------------------------------------------------
// In-memory fixed-window (default)
// ---------------------------------------------------------------------------
// One counter per id, valid until windowEndsAt. The first request in a window sets the
// window; subsequent requests in the same window increment. Once the window passes the
// counter resets. Per-process only, but still throttles a hot instance.

interface Window {
  count: number;
  windowEndsAt: number; // epoch ms
}

export class InMemoryRateLimiter implements RateLimiter {
  private windows = new Map<string, Window>();
  // Bound the map: without eviction it grows one entry per distinct id (per client IP/bucket)
  // forever, since expired windows are only overwritten when the SAME id is seen again. When the
  // map crosses the soft cap we sweep expired windows; if it is still over a hard cap we drop the
  // oldest-inserted keys (Map preserves insertion order). This is a soft throttle, so dropping a
  // stale counter at most lets one client's window reset early - never a correctness problem.
  private static readonly SOFT_CAP = 20_000;
  private static readonly HARD_CAP = 50_000;

  private prune(now: number): void {
    if (this.windows.size <= InMemoryRateLimiter.SOFT_CAP) return;
    for (const [k, w] of this.windows) if (now >= w.windowEndsAt) this.windows.delete(k);
    if (this.windows.size > InMemoryRateLimiter.HARD_CAP) {
      let toDrop = this.windows.size - InMemoryRateLimiter.HARD_CAP;
      for (const k of this.windows.keys()) {
        if (toDrop-- <= 0) break;
        this.windows.delete(k);
      }
    }
  }

  async check(id: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const now = Date.now();
    this.prune(now);
    const windowMs = Math.max(1, windowSeconds) * 1000;
    let w = this.windows.get(id);
    if (!w || now >= w.windowEndsAt) {
      w = { count: 0, windowEndsAt: now + windowMs };
      this.windows.set(id, w);
    }
    w.count += 1;
    const resetSeconds = Math.max(0, Math.ceil((w.windowEndsAt - now) / 1000));
    if (w.count > limit) {
      return { ok: false, remaining: 0, resetSeconds };
    }
    return { ok: true, remaining: Math.max(0, limit - w.count), resetSeconds };
  }

  async peek(id: string): Promise<{ count: number; resetSeconds: number }> {
    const now = Date.now();
    const w = this.windows.get(id);
    if (!w || now >= w.windowEndsAt) return { count: 0, resetSeconds: 0 };
    return { count: w.count, resetSeconds: Math.max(1, Math.ceil((w.windowEndsAt - now) / 1000)) };
  }
}

// ---------------------------------------------------------------------------
// Upstash / Vercel KV fixed-window (shared)
// ---------------------------------------------------------------------------
// INCR the id's counter; on the first hit of a window (result === 1) set EXPIRE so the
// key clears itself when the window ends. Done as one pipeline round-trip. On any
// transport failure the limiter fails OPEN (allows the request) so a broken limiter never
// takes the product down; the CH budget guard below fails CLOSED instead, deliberately.

interface UpstashCfg {
  url: string;
  token: string;
}

export class UpstashRateLimiter implements RateLimiter {
  // When Upstash cannot be reached, every bucket falls back to this per-process counter rather
  // than failing open. Failing open removed the login limits during an outage (WP-QA06 S3): a
  // brute force only had to wait for Upstash to wobble. Per-process is weaker than shared (each
  // serverless instance counts alone) but it is never no limit at all.
  private readonly fallback = new InMemoryRateLimiter();
  constructor(private readonly cfg: UpstashCfg) {}

  private async degradedCheck(id: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    return { ...(await this.fallback.check(id, limit, windowSeconds)), degraded: true };
  }

  async check(id: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const key = `orig:rl:${id}`;
    const ttl = Math.max(1, Math.floor(windowSeconds));
    try {
      // Pipeline: INCR then set EXPIRE. Upstash returns [{result}, {result}].
      const res = await fetch(`${this.cfg.url}/pipeline`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.cfg.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify([
          ["INCR", key],
          ["EXPIRE", key, ttl, "NX"],
          ["TTL", key],
        ]),
        cache: "no-store",
      } as RequestInit);
      if (!res.ok) return this.degradedCheck(id, limit, windowSeconds);
      const body = (await res.json()) as Array<{ result?: unknown }>;
      const count = Number(body?.[0]?.result ?? 0);
      const ttlLeft = Number(body?.[2]?.result ?? ttl);
      const resetSeconds = ttlLeft > 0 ? ttlLeft : ttl;
      if (count > limit) return { ok: false, remaining: 0, resetSeconds };
      return { ok: true, remaining: Math.max(0, limit - count), resetSeconds };
    } catch {
      // Never let a limiter outage break the request path, and never let it remove the limit:
      // count in this process instead. Still flagged degraded so a caller that needs a hard
      // ceiling (the CH budget) knows the shared counter was not consulted.
      return this.degradedCheck(id, limit, windowSeconds);
    }
  }

  // GET and TTL in one round trip. On an outage it reads the per-process fallback that check()
  // counted into, so the failed-login gate still sees the failures of this instance.
  async peek(id: string): Promise<{ count: number; resetSeconds: number }> {
    const key = `orig:rl:${id}`;
    try {
      const res = await fetch(`${this.cfg.url}/pipeline`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.cfg.token}`, "Content-Type": "application/json" },
        body: JSON.stringify([
          ["GET", key],
          ["TTL", key],
        ]),
        cache: "no-store",
      } as RequestInit);
      if (!res.ok) return this.fallback.peek(id);
      const body = (await res.json()) as Array<{ result?: unknown }>;
      const count = Number(body?.[0]?.result ?? 0) || 0;
      const ttl = Number(body?.[1]?.result ?? 0);
      return { count, resetSeconds: ttl > 0 ? ttl : 0 };
    } catch {
      return this.fallback.peek(id);
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function rateLimiterBackend(): "upstash" | "memory" {
  return upstashConfig() ? "upstash" : "memory";
}

// Hung off globalThis, not a module-level `let`: in Next.js dev each route is bundled separately,
// so a module-level singleton would fragment the in-memory rate-limit / CH-budget counter per
// bundle, letting the shared budget be undercounted. globalThis is shared across every bundle in
// the one process. (With Upstash configured the counter is external, so this is moot.)
const g = globalThis as unknown as { __rateLimiter__?: RateLimiter | null };

export function getRateLimiter(): RateLimiter {
  if (!g.__rateLimiter__) {
    const cfg = upstashConfig();
    g.__rateLimiter__ = cfg ? new UpstashRateLimiter(cfg) : new InMemoryRateLimiter();
  }
  return g.__rateLimiter__;
}

export function resetRateLimiterForTests(): void {
  g.__rateLimiter__ = null;
}

// ---------------------------------------------------------------------------
// Client IP + typed errors
// ---------------------------------------------------------------------------

// Minimal header reader satisfied by both the WHATWG `Headers` (Request.headers) and
// Next's ReadonlyHeaders (next/headers), so callers on either side can share this.
export interface HeaderReader {
  get(name: string): string | null;
}

// The per-IP identity for the soft throttle. Prefer the platform-set `x-real-ip`: on Vercel (and
// most proxies) it is the real client IP the edge observed and is NOT client-controlled. The
// LEFTMOST hop of `x-forwarded-for` IS client-supplied and spoofable - a client could rotate fake
// values to dodge the per-IP limit - so it is used only as a fallback. This identity is a best-
// effort throttle, never a security boundary. Values are length-capped so a huge header cannot be
// used as an unbounded map key.
export function clientIp(headers: HeaderReader): string {
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real.slice(0, 64);
  const first = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return (first || "unknown").slice(0, 64);
}

// Thrown by assertChBudget() when the global Companies House budget is exhausted. Typed so
// the /live UI can catch it specifically and show an honest "retry shortly" message rather
// than a generic failure.
export class ChBudgetError extends Error {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super("Companies House budget exceeded, retry shortly");
    this.name = "ChBudgetError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// The global CH budget. CH's real ceiling is 600 requests / 5 minutes; we guard a little
// under it so a burst plus in-flight calls cannot tip us over. Overridable by env for
// tuning across the fleet.
const CH_WINDOW_SECONDS = 300;
function chBudgetLimit(): number {
  const fromEnv = Number(process.env.CH_BUDGET_PER_5MIN);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
  return 550; // headroom under CH's 600 / 5 min
}

// A per-process budget fallback used ONLY when the shared counter is unreachable. Fully failing
// open there would remove the CH ceiling entirely (a fleet could blow past CH's 600/5min); fully
// failing closed would block all live traffic on a counter outage. The middle path: when the shared
// store is degraded, bound THIS instance to the same budget locally, so a single instance can still
// never exceed CH's ceiling on its own. Hung off globalThis so dev bundling shares the one counter.
const budgetG = globalThis as unknown as { __chBudgetFallback__?: RateLimiter };
function budgetFallback(): RateLimiter {
  if (!budgetG.__chBudgetFallback__) budgetG.__chBudgetFallback__ = new InMemoryRateLimiter();
  return budgetG.__chBudgetFallback__;
}

// Call once immediately before each Companies House upstream request. Increments the global
// counter and throws ChBudgetError as it reaches the budget, so we back off before CH itself
// returns 429. When the SHARED counter is unreachable (degraded), it does NOT silently fail open:
// it applies a per-process budget of the same size, so an outage degrades the ceiling to per-
// instance rather than removing it.
export async function assertChBudget(): Promise<void> {
  const limit = chBudgetLimit();
  const primary = await getRateLimiter().check("ch-global-budget", limit, CH_WINDOW_SECONDS);
  if (!primary.ok) throw new ChBudgetError(primary.resetSeconds || CH_WINDOW_SECONDS);
  if (primary.degraded) {
    // The shared counter failed open; enforce a per-process ceiling instead of no ceiling.
    const local = await budgetFallback().check("ch-global-budget", limit, CH_WINDOW_SECONDS);
    if (!local.ok) throw new ChBudgetError(local.resetSeconds || CH_WINDOW_SECONDS);
  }
}
