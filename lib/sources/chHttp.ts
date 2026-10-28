// lib/sources/chHttp.ts
// One way to call the Companies House JSON API: paced, charged to the budget, and retried when
// the failure is transient (WP-BE14).
//
// Why. On 27 Sep (WP-QA04) names 18 to 30 failed at resolve in one 20-second burst, one with
// "This operation was aborted" and twelve with "fetch failed", and every one passed on a re-run.
// Nothing retried, and nothing spaced the calls of one run from the next. The document download
// (fetchDoc.ts) already retried; the JSON calls behind search, profile and filing history did not.
//
// What it does, per call:
//   1. PACE. A shared, process-wide pacer spaces the START of every Companies House call by a
//      minimum interval, across every run in the process. A 429 with Retry-After pushes the
//      pacer out, so the next run's calls wait too instead of meeting the same 429.
//   2. BUDGET. assertChBudget() before every attempt, retries included, as before.
//   3. RETRY. A network error (fetch failed, a reset, a timeout abort) or a 429 / 5xx is tried
//      again, at most `retries` times, with exponential backoff and jitter. A 429 or 503 that
//      carries Retry-After waits what it says, if that is short enough to be worth waiting;
//      otherwise the response is handed back and the caller says "rate limit" as before.
//   Never retried: a 4xx other than 408 and 429 (it is an answer), an oversize body, a budget
//   refusal. After the last attempt a network error becomes ChUnreachableError, whose message
//   is plain words for the run record; the raw cause stays on `.cause` for the logs.
//
// Tunable by env for tests and for the fleet: CH_RETRIES, CH_RETRY_BASE_MS, CH_MIN_INTERVAL_MS,
// CH_MAX_RETRY_AFTER_MS. Read at call time, so a test can set them after import.

import { assertChBudget, ChBudgetError } from "../ratelimit/ratelimit";
import { fetchTextLimited, ResponseTooLargeError, type FetchLimitOptions, type LimitedResponse } from "./fetchLimits";

export interface ChRetryOptions {
  retries?: number; // extra attempts after the first (default 3, so 4 in all)
  baseDelayMs?: number; // backoff: base * 2^attempt + jitter up to base / 2 (default 750)
  maxRetryAfterMs?: number; // a Retry-After longer than this is not waited for (default 10 s)
  minIntervalMs?: number; // pacer spacing between call starts (default 150)
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  // Charged before each attempt. Defaults to assertChBudget; tests pass a no-op.
  beforeAttempt?: () => Promise<void>;
}

// A network error that outlived every retry. The message is what a user reads in the run record.
export class ChUnreachableError extends Error {
  readonly attempts: number;
  constructor(attempts: number, cause: unknown) {
    super(
      `Companies House could not be reached (${kindOf(cause)}, ${attempts} ${attempts === 1 ? "try" : "tries"}). ` +
        "Nothing about the company was learned; this is a connection problem, not an answer. Try again in a minute.",
    );
    this.name = "ChUnreachableError";
    this.attempts = attempts;
    (this as { cause?: unknown }).cause = cause;
  }
}

const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Is this thrown error a transient network failure worth another try?
export function isTransientNetworkError(err: unknown): boolean {
  if (err instanceof ResponseTooLargeError || err instanceof ChBudgetError) return false;
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError" || err.name === "TimeoutError") return true;
  // undici throws TypeError("fetch failed") with the socket error on .cause.
  const text = `${err.message} ${(err as { cause?: { code?: string; message?: string } }).cause?.code ?? ""} ${
    (err as { cause?: { message?: string } }).cause?.message ?? ""
  }`;
  return /fetch failed|aborted|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|UND_ERR|socket|network|terminated/i.test(
    text,
  );
}

function kindOf(err: unknown): string {
  if (err instanceof Error && (err.name === "AbortError" || /aborted/i.test(err.message))) return "no answer in time";
  return "a network error";
}

// Retry-After is seconds or an HTTP date. Returns milliseconds from now, or null.
export function parseRetryAfter(value: string | null | undefined, now: number): number | null {
  if (!value) return null;
  const s = value.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const at = Date.parse(s);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

// ---------------------------------------------------------------------------
// The pacer. On globalThis so dev bundling and every run in the process share the one clock.
// ---------------------------------------------------------------------------
interface PacerState {
  next: number; // earliest start time for the next call, ms since epoch
}
const pacerG = globalThis as unknown as { __chPacer__?: PacerState };
function pacer(): PacerState {
  if (!pacerG.__chPacer__) pacerG.__chPacer__ = { next: 0 };
  return pacerG.__chPacer__;
}

export function resetChPacerForTests(): void {
  pacerG.__chPacer__ = { next: 0 };
}

// Reserve the next slot and wait for it. Reservation is synchronous, so concurrent callers queue.
export async function paceChCall(opts: Pick<ChRetryOptions, "minIntervalMs" | "sleep" | "now"> = {}): Promise<void> {
  const now = (opts.now ?? Date.now)();
  const interval = opts.minIntervalMs ?? envNumber("CH_MIN_INTERVAL_MS", 150);
  const p = pacer();
  const slot = Math.max(now, p.next);
  p.next = slot + interval;
  const wait = slot - now;
  if (wait > 0) await (opts.sleep ?? defaultSleep)(wait);
}

// Push every later call out to at least `until` (a Retry-After the register asked for).
function holdPacer(until: number): void {
  const p = pacer();
  if (until > p.next) p.next = until;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// The budget guard plus the pacer, for fetchChDocument's beforeAttempt.
export async function chBeforeAttempt(): Promise<void> {
  await paceChCall();
  await assertChBudget();
}

// Fetch a Companies House URL as text: paced, budgeted, retried. Returns the last response for
// the caller to judge its status (404 is an answer, 401 is a key problem). Throws
// ChUnreachableError when every attempt failed on the network, and passes ChBudgetError and
// ResponseTooLargeError straight through.
export async function chFetchText(
  url: string,
  opts: FetchLimitOptions & { retry?: ChRetryOptions } = {},
): Promise<LimitedResponse> {
  const r = opts.retry ?? {};
  const retries = r.retries ?? envNumber("CH_RETRIES", 3);
  const base = r.baseDelayMs ?? envNumber("CH_RETRY_BASE_MS", 750);
  const maxRetryAfter = r.maxRetryAfterMs ?? envNumber("CH_MAX_RETRY_AFTER_MS", 10_000);
  const sleep = r.sleep ?? defaultSleep;
  const now = r.now ?? Date.now;
  const random = r.random ?? Math.random;
  const before = r.beforeAttempt ?? assertChBudget;
  const { retry: _ignored, ...fetchOpts } = opts;

  const backoff = (attempt: number) => base * 2 ** attempt + Math.floor(random() * (base / 2));

  for (let attempt = 0; ; attempt++) {
    await paceChCall({ minIntervalMs: r.minIntervalMs, sleep, now });
    await before();
    let res: LimitedResponse;
    try {
      res = await fetchTextLimited(url, fetchOpts);
    } catch (err) {
      if (!isTransientNetworkError(err)) throw err;
      if (attempt >= retries) throw new ChUnreachableError(attempt + 1, err);
      await sleep(backoff(attempt));
      continue;
    }
    if (!RETRY_STATUS.has(res.status) || attempt >= retries) return res;

    const asked = parseRetryAfter(res.retryAfter, now());
    if (asked !== null) {
      // The register named its own wait. Hold every later call in the process to it, and wait
      // it here if it is short enough to be worth it; if not, hand the answer back now.
      holdPacer(now() + asked);
      if (asked > maxRetryAfter) return res;
      await sleep(asked);
    } else {
      await sleep(backoff(attempt));
    }
  }
}
