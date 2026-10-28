// test/hosting.test.ts
// Exercises the hosting-for-scale seams: the in-memory cache (get / set / ttl expiry /
// eviction / del), the cacheBackend() + getCache() defaults, and the in-memory rate
// limiter (allows `limit` requests then denies with a resetSeconds).
//
// The cache and rate limiter are ASYNC, but the harness runs synchronously, so the async
// work happens inside registerHostingTests() (which the runner AWAITS before run()) and
// every assertion below reads a value captured during that setup. This mirrors
// test/companiesHouseLive.test.ts.

import {
  InMemoryCache,
  cacheBackend,
  getCache,
  resetCacheForTests,
} from "../lib/cache/cache";
import {
  InMemoryRateLimiter,
  clientIp,
  type RateLimitResult,
} from "../lib/ratelimit/ratelimit";
import { suite, test, assert, assertEqual } from "./harness";

// --- Captured during async setup ---------------------------------------------
let hit: { n: number } | null;
let miss: unknown;
let ttlExpired: unknown;
let deleted: unknown;
let evictedOldest: unknown;
let evictedKept: unknown;
let evictedNewest: unknown;
let byteEvicted: unknown;
let byteKept: unknown;
let ipRealWins = "";
let ipXffFallback = "";
let defaultBackend: "upstash" | "memory";
let defaultIsMemory = false;
let rlResults: RateLimitResult[] = [];

export async function registerHostingTests(): Promise<void> {
  // --- Cache: get / set / miss / ttl / del ---
  const cache = new InMemoryCache(100);
  await cache.set("a", { n: 1 }, 60);
  hit = await cache.get<{ n: number }>("a");
  miss = await cache.get("does-not-exist");

  // ttl 0 => expired on read (immediate expiry).
  await cache.set("ttl0", 42, 0);
  ttlExpired = await cache.get("ttl0");

  // del removes the entry.
  await cache.set("d", 7, 60);
  await cache.del("d");
  deleted = await cache.get("d");

  // --- Cache: size-cap eviction (cap 3, insert 4 => oldest evicted) ---
  const ev = new InMemoryCache(3);
  await ev.set("k1", 1, 60);
  await ev.set("k2", 2, 60);
  await ev.set("k3", 3, 60);
  await ev.set("k4", 4, 60); // pushes size to 4 => evicts the oldest (k1)
  evictedOldest = await ev.get("k1"); // gone
  evictedKept = await ev.get("k2"); // still present
  evictedNewest = await ev.get("k4"); // present

  // --- Cache: BYTE-budget eviction (roomy entry cap, tiny byte budget) ---
  const bytes = new InMemoryCache(1000, 50); // 50-byte budget, count cap not the binding constraint
  await bytes.set("big1", "x".repeat(40), 60); // ~42 bytes serialised
  await bytes.set("big2", "y".repeat(40), 60); // total ~84 > 50 -> evicts big1 by bytes, not by count
  byteEvicted = await bytes.get("big1");
  byteKept = await bytes.get("big2");

  // --- clientIp: the platform x-real-ip beats a spoofable x-forwarded-for; XFF is only a fallback ---
  ipRealWins = clientIp({ get: (n) => (n === "x-real-ip" ? "9.9.9.9" : n === "x-forwarded-for" ? "1.1.1.1" : null) });
  ipXffFallback = clientIp({ get: (n) => (n === "x-forwarded-for" ? "1.1.1.1, 2.2.2.2" : null) });

  // --- Defaults with no env: memory backend ---
  resetCacheForTests();
  defaultBackend = cacheBackend();
  defaultIsMemory = getCache() instanceof InMemoryCache;

  // --- Rate limiter: allow `limit`, then deny with a resetSeconds ---
  const limiter = new InMemoryRateLimiter();
  rlResults = [];
  for (let i = 0; i < 5; i++) {
    rlResults.push(await limiter.check("client-x", 3, 60));
  }

  registerCases();
}

function registerCases(): void {
  suite("hosting / InMemoryCache");

  test("set then get returns the stored value", () => {
    assert(hit !== null && hit.n === 1, "value round-trips through the cache");
  });

  test("a missing key returns null (not an error)", () => {
    assertEqual(miss, null, "unknown key is a miss");
  });

  test("ttl 0 expires immediately", () => {
    assertEqual(ttlExpired, null, "a zero-ttl entry is dead on read");
  });

  test("del removes the entry", () => {
    assertEqual(deleted, null, "deleted key is a miss");
  });

  test("size cap evicts the oldest entry", () => {
    assertEqual(evictedOldest, null, "k1 evicted when the cap is exceeded");
    assertEqual(evictedKept, 2, "k2 retained");
    assertEqual(evictedNewest, 4, "k4 (newest) retained");
  });

  test("byte budget evicts by memory, not just entry count", () => {
    assertEqual(byteEvicted, null, "big1 evicted once the byte budget is exceeded");
    assert(typeof byteKept === "string", "the just-inserted big2 is retained");
  });

  test("clientIp prefers the platform x-real-ip over a spoofable x-forwarded-for", () => {
    assertEqual(ipRealWins, "9.9.9.9", "x-real-ip wins when present");
    assertEqual(ipXffFallback, "1.1.1.1", "the leftmost XFF hop is used only as a fallback");
  });

  suite("hosting / cache backend defaults");

  test("cacheBackend() defaults to memory with no env", () => {
    assertEqual(defaultBackend, "memory", "no Upstash / KV env => memory");
  });

  test("getCache() returns the in-memory cache with no env", () => {
    assert(defaultIsMemory, "getCache() is an InMemoryCache by default");
  });

  suite("hosting / InMemoryRateLimiter");

  test("allows exactly `limit` requests in a window", () => {
    assert(rlResults[0].ok, "1st request ok");
    assert(rlResults[1].ok, "2nd request ok");
    assert(rlResults[2].ok, "3rd (== limit) request ok");
  });

  test("denies once over the limit, with remaining 0", () => {
    assertEqual(rlResults[3].ok, false, "4th request denied");
    assertEqual(rlResults[3].remaining, 0, "no remaining once over the limit");
  });

  test("a denied request reports seconds until the window resets", () => {
    assert(rlResults[3].resetSeconds > 0, "resetSeconds is positive");
    assert(rlResults[3].resetSeconds <= 60, "resetSeconds within the window");
  });

  test("remaining counts down while under the limit", () => {
    assertEqual(rlResults[0].remaining, 2, "after 1 of 3, 2 remain");
    assertEqual(rlResults[1].remaining, 1, "after 2 of 3, 1 remains");
    assertEqual(rlResults[2].remaining, 0, "after 3 of 3, 0 remain");
  });
}
