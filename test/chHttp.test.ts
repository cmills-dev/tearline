// test/chHttp.test.ts
// WP-BE14: the Companies House JSON calls retry transient failures and share one pacer.
// Every case uses a stub fetch and a recorded sleep, so nothing waits and nothing leaves the box.

import { suite, test, assert, assertEqual } from "./harness";
import {
  chFetchText,
  ChUnreachableError,
  isTransientNetworkError,
  paceChCall,
  parseRetryAfter,
  resetChPacerForTests,
} from "../lib/sources/chHttp";
import { ResponseTooLargeError } from "../lib/sources/fetchLimits";
import { explainRunError } from "../lib/run/plainError";
import { DEFAULT_BUDGET } from "../lib/run/runner";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

type Step = () => Response | Promise<Response>;

function stubFetch(steps: Step[]): { fetchImpl: typeof fetch; calls: () => number } {
  let i = 0;
  const fetchImpl = (async () => {
    const step = steps[Math.min(i, steps.length - 1)];
    i++;
    return step();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => i };
}

const ok = (): Response => new Response(JSON.stringify({ items: [] }), { status: 200 });
const status = (s: number, headers: Record<string, string> = {}) => (): Response =>
  new Response("{}", { status: s, headers });
const netFail = () => (): Response => {
  throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
};

function clock() {
  let t = 1_000_000;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
    slept,
  };
}

const noBudget = async () => {};

export async function registerChHttpTests(): Promise<void> {
  suite("WP-BE14 Companies House calls: retry and pacing");

  test("a burst of 'fetch failed' is retried and the call succeeds (QA04 names 18 to 30)", async () => {
    resetChPacerForTests();
    const c = clock();
    const f = stubFetch([netFail(), netFail(), ok]);
    const res = await chFetchText("https://ch.test/search", {
      fetchImpl: f.fetchImpl,
      retry: { sleep: c.sleep, now: c.now, random: () => 0, baseDelayMs: 100, minIntervalMs: 0, beforeAttempt: noBudget },
    });
    assertEqual(res.status, 200, "the third attempt answers");
    assertEqual(f.calls(), 3, "three attempts");
    assertEqual(JSON.stringify(c.slept), JSON.stringify([100, 200]), "exponential backoff between them");
  });

  test("an aborted call (the 20 second timeout) is transient too", () => {
    const abort = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    assert(isTransientNetworkError(abort), "AbortError retries");
    assert(isTransientNetworkError(new TypeError("fetch failed")), "fetch failed retries");
    assert(!isTransientNetworkError(new ResponseTooLargeError(10, 5)), "an oversize body does not");
    assert(!isTransientNetworkError(new Error("Companies House: authentication failed")), "an ordinary error does not");
  });

  test("retries are bounded, and the last failure is said in plain words", async () => {
    resetChPacerForTests();
    const c = clock();
    const f = stubFetch([netFail()]);
    let err: unknown = null;
    try {
      await chFetchText("https://ch.test/x", {
        fetchImpl: f.fetchImpl,
        retry: { retries: 3, sleep: c.sleep, now: c.now, random: () => 0, baseDelayMs: 10, minIntervalMs: 0, beforeAttempt: noBudget },
      });
    } catch (e) {
      err = e;
    }
    assert(err instanceof ChUnreachableError, `a ChUnreachableError, got ${String(err)}`);
    assertEqual(f.calls(), 4, "one try and three retries, no more");
    const msg = (err as Error).message;
    assert(msg.startsWith("Companies House could not be reached"), msg);
    assert(!/fetch failed/.test(msg), "the raw undici text is not in the message");
  });

  test("a 503 is retried; a 404 and a 401 are answers and are not", async () => {
    resetChPacerForTests();
    const c = clock();
    const f = stubFetch([status(503), ok]);
    const res = await chFetchText("https://ch.test/p", {
      fetchImpl: f.fetchImpl,
      retry: { sleep: c.sleep, now: c.now, random: () => 0, baseDelayMs: 10, minIntervalMs: 0, beforeAttempt: noBudget },
    });
    assertEqual(res.status, 200, "503 then 200");
    for (const s of [404, 401]) {
      const g = stubFetch([status(s), ok]);
      const r = await chFetchText("https://ch.test/p", {
        fetchImpl: g.fetchImpl,
        retry: { sleep: c.sleep, now: c.now, minIntervalMs: 0, beforeAttempt: noBudget },
      });
      assertEqual(r.status, s, `${s} comes straight back`);
      assertEqual(g.calls(), 1, `${s} is not retried`);
    }
  });

  test("a 429 waits what Retry-After says, and holds the pacer for the next run", async () => {
    resetChPacerForTests();
    const c = clock();
    const f = stubFetch([status(429, { "retry-after": "3" }), ok]);
    const res = await chFetchText("https://ch.test/p", {
      fetchImpl: f.fetchImpl,
      retry: { sleep: c.sleep, now: c.now, baseDelayMs: 10, minIntervalMs: 0, beforeAttempt: noBudget },
    });
    assertEqual(res.status, 200, "retried after the wait");
    assert(c.slept.includes(3000), `waited 3000 ms: ${JSON.stringify(c.slept)}`);
  });

  test("a Retry-After too long to wait hands the 429 back at once and pushes later calls out", async () => {
    resetChPacerForTests();
    const c = clock();
    const f = stubFetch([status(429, { "retry-after": "120" }), ok]);
    const res = await chFetchText("https://ch.test/p", {
      fetchImpl: f.fetchImpl,
      retry: { sleep: c.sleep, now: c.now, maxRetryAfterMs: 10_000, minIntervalMs: 0, beforeAttempt: noBudget },
    });
    assertEqual(res.status, 429, "the caller gets the 429 and says rate limit");
    assertEqual(f.calls(), 1, "no retry");
    // Another run's call in the same process now waits for the register's window.
    await paceChCall({ minIntervalMs: 0, sleep: c.sleep, now: c.now });
    assertEqual(c.slept[c.slept.length - 1], 120_000, "the next call waits out the Retry-After");
  });

  test("the pacer spaces call starts across callers", async () => {
    resetChPacerForTests();
    // Three callers arrive at the same instant; the clock does not move while they queue.
    const slept: number[] = [];
    const sleep = async (ms: number) => {
      slept.push(ms);
    };
    await Promise.all([1, 2, 3].map(() => paceChCall({ minIntervalMs: 150, sleep, now: () => 5_000 })));
    assertEqual(JSON.stringify(slept), JSON.stringify([150, 300]), "the second waits 150, the third 300");
  });

  test("Retry-After as seconds and as an HTTP date", () => {
    assertEqual(parseRetryAfter("5", 0), 5000, "seconds");
    const now = Date.parse("2026-09-27T12:00:00Z");
    assertEqual(parseRetryAfter("Sun, 27 Sep 2026 12:00:07 GMT", now), 7000, "a date");
    assertEqual(parseRetryAfter("soon", now), null, "nonsense");
    assertEqual(parseRetryAfter(null, now), null, "absent");
  });

  test("the budget is charged before every attempt, retries included", async () => {
    resetChPacerForTests();
    const c = clock();
    let charged = 0;
    const f = stubFetch([netFail(), status(502), ok]);
    await chFetchText("https://ch.test/p", {
      fetchImpl: f.fetchImpl,
      retry: {
        sleep: c.sleep,
        now: c.now,
        baseDelayMs: 1,
        minIntervalMs: 0,
        beforeAttempt: async () => {
          charged++;
        },
      },
    });
    assertEqual(charged, 3, "three attempts, three charges");
  });

  suite("WP-BE14 run record: raw transport errors become plain words");

  test("'fetch failed' and an abort are explained, not quoted", () => {
    const a = explainRunError(new TypeError("fetch failed"));
    assert(!/fetch failed/.test(a) && /could not be reached/.test(a), a);
    const b = explainRunError(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
    assert(!/operation was aborted/.test(b) && /did not answer in time/.test(b), b);
  });
  test("a plain error from our own code is kept as it is", () => {
    const m = "Companies House: authentication failed. Check CH_API_KEY.";
    assertEqual(explainRunError(new Error(m)), m, "unchanged");
  });

  suite("WP-BE14 run budget: the stage slices fit the work they measure");

  test("every stage that finished on 23 Sep fits its slice, and the total is unchanged", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const file = join(here, "..", "eval", "names", "results-2026-09-23.jsonl");
    const over: string[] = [];
    let counted = 0;
    for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
      const r = JSON.parse(line) as { name: string; stages?: Array<{ stage: keyof typeof DEFAULT_BUDGET.stageMs; status: string; elapsedMs: number | null; detail?: string }> };
      for (const st of r.stages ?? []) {
        // Only work that finished with a result: a model failure is not a duration to fit.
        if (st.status !== "done" || st.elapsedMs === null || /model-failure/.test(st.detail ?? "")) continue;
        counted++;
        if (st.elapsedMs > DEFAULT_BUDGET.stageMs[st.stage]) over.push(`${r.name} ${st.stage} ${st.elapsedMs} ms`);
      }
    }
    assert(counted > 100, `read the recorded stages (${counted})`);
    assertEqual(over.join("; "), "", "no finished stage runs past its slice (four verify and one extract did at 30 s and 70 s)");
    assertEqual(DEFAULT_BUDGET.totalMs, 120_000, "the whole run is still capped at 120 s");
  });
}
