// lib/cache/cache.ts
// The caching seam. A single tiny interface (get / set / del) with two implementations
// selected purely by environment. With no env set the process runs on an in-memory cache
// that still cuts repeat work within one serverless instance. Set the Upstash / Vercel KV
// REST env and every instance shares one durable cache, which is what makes caching
// correct (not just local) across serverless invocations.
//
// No SDK dependency: the shared cache talks to the Upstash Redis REST API over plain
// fetch, so the build needs nothing installed to ship. The flip is env-only.

export interface Cache {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}

// All keys are namespaced so a shared Redis can host other tenants / apps without
// collision, and so a flush of this app's keys is scoped.
const NS = "orig:";
function nsKey(key: string): string {
  return key.startsWith(NS) ? key : NS + key;
}

// ---------------------------------------------------------------------------
// In-memory (default): per-process, not shared, but still cuts repeat work.
// ---------------------------------------------------------------------------
// A Map with per-key expiry and a simple size cap. Map preserves insertion order, so
// eviction drops the oldest entry; a get moves its key to the most-recent position, so
// eviction is LRU-ish rather than strict FIFO.

interface Entry {
  value: unknown;
  expiresAt: number; // epoch ms; entry is expired when Date.now() >= expiresAt
  bytes: number; // approx serialised size, so the cache is bounded by MEMORY, not just entry count
}

export class InMemoryCache implements Cache {
  private store = new Map<string, Entry>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private totalBytes = 0;

  // Bounded by BOTH an entry count and an approximate byte budget. Entry count alone does not bound
  // memory: a single SEC companyfacts (tens of MB) or ESEF facts doc (100MB+) is one entry, so 1000
  // of them is gigabytes. The byte budget evicts oldest-first until the process cache fits its cap.
  constructor(maxEntries = 1000, maxBytes = 256 * 1024 * 1024) {
    this.maxEntries = Math.max(1, maxEntries);
    this.maxBytes = Math.max(1, maxBytes);
  }

  private estimateBytes(value: unknown): number {
    try {
      const s = JSON.stringify(value);
      return typeof s === "string" ? s.length : 0;
    } catch {
      return 0; // circular / unserialisable -> treat as weightless rather than throw
    }
  }

  private drop(k: string): void {
    const e = this.store.get(k);
    if (e) {
      this.totalBytes -= e.bytes;
      this.store.delete(k);
    }
  }

  async get<T>(key: string): Promise<T | null> {
    const k = nsKey(key);
    const entry = this.store.get(k);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      this.drop(k);
      return null;
    }
    // LRU-ish: touch moves the key to the most-recently-used end (byte total is unchanged).
    this.store.delete(k);
    this.store.set(k, entry);
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    const k = nsKey(key);
    // ttl <= 0 means "expire immediately" (used by tests); the entry is dead on arrival.
    const expiresAt = Date.now() + Math.max(0, ttlSeconds) * 1000;
    this.drop(k); // remove any prior entry (and its bytes) first
    const bytes = this.estimateBytes(value);
    this.store.set(k, { value, expiresAt, bytes });
    this.totalBytes += bytes;
    // Evict the oldest entries until back within BOTH the entry cap and the byte budget.
    while (this.store.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined || oldest === k) break; // never evict the entry just inserted
      this.drop(oldest);
    }
  }

  async del(key: string): Promise<void> {
    this.drop(nsKey(key));
  }
}

// ---------------------------------------------------------------------------
// Upstash / Vercel KV (shared): the durable, cross-instance cache.
// ---------------------------------------------------------------------------
// Talks to the Upstash Redis REST API over fetch. Values are JSON-serialised so any
// structured value round-trips. A network failure degrades gracefully to a miss on get
// (so a broken cache never breaks a request) and is swallowed on set / del.

interface UpstashConfig {
  url: string;
  token: string;
}

// Vercel KV exposes KV_REST_API_URL / KV_REST_API_TOKEN; a raw Upstash database exposes
// UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN. Either pair enables the shared cache.
export function upstashConfig(): UpstashConfig | null {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return { url: url.replace(/\/$/, ""), token };
  return null;
}

export class UpstashRedisCache implements Cache {
  constructor(private readonly cfg: UpstashConfig) {}

  // Runs a single Redis command via the REST API. The command is the JSON body, e.g.
  // ["SET", key, value, "EX", "60"]. Returns the parsed `result` field, or null on any
  // transport / status failure so callers can treat it as a cache miss.
  private async command(args: (string | number)[]): Promise<unknown> {
    const res = await fetch(this.cfg.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.cfg.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
      cache: "no-store",
    } as RequestInit);
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: unknown; error?: string };
    if (body.error) return null;
    return body.result ?? null;
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const result = await this.command(["GET", nsKey(key)]);
      if (result == null || typeof result !== "string") return null;
      return JSON.parse(result) as T;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    try {
      const ttl = Math.max(1, Math.floor(ttlSeconds));
      await this.command(["SET", nsKey(key), JSON.stringify(value), "EX", ttl]);
    } catch {
      // A failed write is a silent miss next time, never a request failure.
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.command(["DEL", nsKey(key)]);
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

// Which backend getCache() will use, for honest reporting in /api/health.
export function cacheBackend(): "upstash" | "memory" {
  return upstashConfig() ? "upstash" : "memory";
}

// Hung off globalThis, not a module-level `let`: in Next.js dev each route is bundled separately,
// so a module-level singleton would give each bundle its own in-memory cache Map, fragmenting the
// CH document/response cache per route. globalThis is shared across every bundle in the one
// process. (With Upstash configured the cache is external, so this is moot.)
const g = globalThis as unknown as { __cache__?: Cache | null };

// Returns the process cache: the shared Upstash cache when its env is present, else the
// per-process in-memory cache. Memoised so the in-memory Map survives across calls within
// one instance.
export function getCache(): Cache {
  if (!g.__cache__) {
    const cfg = upstashConfig();
    g.__cache__ = cfg ? new UpstashRedisCache(cfg) : new InMemoryCache();
  }
  return g.__cache__;
}

// Test / boundary helper: drop the memoised instance so a suite can re-read the env.
export function resetCacheForTests(): void {
  g.__cache__ = null;
}
