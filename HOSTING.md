# Hosting for scale

This app is built to deploy and run **now** on stateless in-memory defaults, and to flip
to shared, durable backends **purely via environment variables**. Nothing below needs a
code change or a new static dependency to ship. Each backend is a seam with two
implementations, chosen at runtime by the presence of an env var.

| Concern | Default (no env) | Shared / durable (flip) | Flip env |
| --- | --- | --- | --- |
| Cache | In-memory per instance | Upstash / Vercel KV over REST | `KV_REST_API_URL` + `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`) |
| Rate limiting | In-memory per instance | Same Upstash / KV backend | same as cache |
| Persistence | In-memory per process | Postgres (Supabase / Neon / Vercel Postgres / plain) | `DATABASE_URL` (+ `npm install postgres`, apply migration) |
| Live data | Fixtures | Companies House public API | `CH_API_KEY` |
| Document parsing | Off | Configured model | `LLM_PROVIDER` / `LLM_MODEL` / ... |

Check what is actually live at any time with the health endpoint (below).

## Region

`vercel.json` pins `regions: ["lhr1"]` (London) for UK / EU latency and data residency.
Provision the shared cache and the database in the same region.

## Caching

`lib/cache/cache.ts` exposes a tiny `Cache` interface (`get` / `set` / `del`) with two
implementations:

- **`InMemoryCache`** (default): a Map with per-key TTL expiry and a size cap with LRU-ish
  eviction. Per-process, not shared, but still cuts repeat work within one instance.
- **`UpstashRedisCache`**: talks to the Upstash Redis REST API over plain `fetch` (no SDK
  dependency). This is the shared cache that makes caching correct across serverless
  instances.

`getCache()` returns the Upstash cache when its env is present, else in-memory.
`cacheBackend()` reports `"upstash"` or `"memory"`.

What is cached (all TTLs approximate):

- Companies House `getProfile` and `getCharges`, keyed by company number, c. 1 hour.
- Companies House `getLatestAccountsIxbrl` (the heavy document hops), keyed by company
  number, c. 6 hours. Only a non-null document is cached.
- The built `.xlsx` model from `/api/model/<key>`, keyed by fixture key, c. 15 min.

Honest behaviour is preserved: a cache **miss still fetches**, a **missing `CH_API_KEY`
still errors** (the key is asserted before the cache is consulted), and **error states and
404s are never cached**.

### Flip: enable the shared cache

1. Create an Upstash Redis database, or add Vercel KV to the project.
2. Set `KV_REST_API_URL` + `KV_REST_API_TOKEN` (Vercel KV sets these automatically), or
   `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` for a raw Upstash database.
3. Redeploy. `/api/health` should now report `cacheBackend: "upstash"`.

## Rate limiting

`lib/ratelimit/ratelimit.ts` is a fixed-window limiter with the same in-memory default and
Upstash-backed (INCR + EXPIRE over REST) shared implementation, selected by the same env
as the cache.

- **Per client IP** (first hop of `x-forwarded-for`), c. 30 requests / minute on
  `/api/model/[key]` and on the `/live` search and build actions. The API route returns
  **HTTP 429 with a `Retry-After` header** on exceed; the `/live` page shows a friendly
  inline "wait Ns" message instead of failing.
- **Global Companies House budget guard**: `assertChBudget()` wraps every CH upstream call
  with a global counter (c. 550 / 5 min, under CH's real 600 / 5 min ceiling; tune with
  `CH_BUDGET_PER_5MIN`). As the budget is reached it throws a typed `ChBudgetError`
  ("Companies House budget exceeded, retry shortly"), which the `/live` UI surfaces
  honestly, so we back off before CH itself returns 429.

The per-IP limiter fails **open** on a shared-store outage (a limiter fault never takes the
product down). The shared backend turns on automatically once the Upstash / KV env is set;
no code change.

## Persistence

`lib/store/tearSheetStore.ts` is the one seam through which validated `FactManifest`s are
saved and read, keyed by **tenant** and record key. Default is `InMemoryTearSheetStore`
(per-process; `storeIsDurable()` returns `false`). The durable adapter is
`PostgresTearSheetStore` (`lib/store/postgres.ts`) against `db/migrations/0001_init.sql`.

`getStore()` returns the Postgres store when `DATABASE_URL` is set, else in-memory.
`storeIsDurable()` reflects `!!DATABASE_URL`. The `postgres` (postgres.js) client is loaded
via a **guarded dynamic import** (with `webpackIgnore`), so it is **not a static
dependency** and the build passes without it installed.

### Flip: enable durable persistence

1. `npm install postgres`
2. Provision Postgres (Supabase / Neon / Vercel Postgres / plain) and set `DATABASE_URL`.
3. Apply the schema: `psql "$DATABASE_URL" -f db/migrations/0001_init.sql`, and enable the
   row-level-security policies at the foot of that migration to enforce the MNPI wall.
4. Redeploy. `/api/health` should now report `storeDurable: true`.

`save()` validates against the frozen contract (`assertPersistable`), upserts the
`tear_sheet` row (with `contract_version = CONTRACT_VERSION`) and explodes facts into the
`fact` table, all in one transaction.

## Health / status

`GET /api/health` (Node runtime, `Cache-Control: no-store`) returns booleans and safe
enums only, **no secrets**:

```json
{
  "status": "ok",
  "contractVersion": "0.1.0",
  "dataMode": "fixtures",
  "llm": "off",
  "storeDurable": false,
  "cacheBackend": "memory",
  "region": "unknown",
  "commit": "dev",
  "time": "2026-07-30T00:00:00.000Z"
}
```

Use it for uptime checks and to confirm which backends a deployment is actually running.

## Function configuration (`vercel.json`)

- `regions: ["lhr1"]` (London).
- `/api/model/[key]` and `/live`: `maxDuration: 30`, `memory: 1024`.
- `/api/health`: `maxDuration: 10`, `memory: 512`.
- Security headers globally (`X-Content-Type-Options: nosniff`, `X-Frame-Options`,
  `Referrer-Policy`), long immutable cache on `/_next/static`, `no-store` on `/api`.

## Environment variable summary

| Var | Effect |
| --- | --- |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Shared cache + shared rate limiter (Vercel KV) |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Same, for a raw Upstash database |
| `DATABASE_URL` | Durable Postgres persistence (needs `npm install postgres` + migration) |
| `CH_BUDGET_PER_5MIN` | Override the global CH budget (default 550) |
| `CH_API_KEY` | Live Companies House data (else fixtures) |
| `LLM_PROVIDER` / `LLM_MODEL` / ... | Enable document parsing (else off) |

With **none** of these set, the app runs end to end on in-memory defaults and the build
needs no new static dependency.
