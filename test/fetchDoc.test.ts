// test/fetchDoc.test.ts
// The CH -> S3 download helper, exercised with a mock fetch (no network). Confirms the
// auth/S3 split, retry-vs-abstain discrimination, and that Authorization never reaches S3.

import { suite, test, assert, assertEqual } from "./harness";
import { fetchChDocument } from "../lib/sources/fetchDoc";

function res(status: number, body: Uint8Array | null, headers: Record<string, string> = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null },
    arrayBuffer: async () => (body ?? new Uint8Array()).buffer,
  } as unknown as Response;
}

const CH = "https://document-api.company-information.service.gov.uk/document/X/content";
const S3 = "https://s3.eu-west-2.amazonaws.com/signed?X-Amz-Signature=abc";
const PDF = new Uint8Array([1, 2, 3, 4]);

suite("fetchDoc / CH -> S3");

export async function registerFetchDocTests(): Promise<void> {
  // 1) happy path: 302 -> S3 200 with bytes, and auth is NOT sent to S3.
  let s3Headers: Record<string, string> | undefined;
  const okFetch = (async (url: string, init?: RequestInit) => {
    if (url === CH) return res(302, null, { location: S3 });
    s3Headers = (init?.headers as Record<string, string>) ?? {};
    return res(200, PDF, { "content-length": "4" });
  }) as unknown as typeof fetch;
  const okBuf = await fetchChDocument(CH, "Basic KEY", { fetchImpl: okFetch, baseDelayMs: 0 });

  // 2) CH 200 with an empty body = not available -> abstain (null), and only ONE call.
  let calls = 0;
  const emptyFetch = (async () => {
    calls++;
    return res(200, new Uint8Array(), { "content-length": "0" });
  }) as unknown as typeof fetch;
  const emptyBuf = await fetchChDocument(CH, "Basic KEY", { fetchImpl: emptyFetch, baseDelayMs: 0, maxRetries: 3 });

  // 3) 302 -> S3 empty (truncation) retries, then succeeds.
  let s3Attempts = 0;
  const flakyFetch = (async (url: string) => {
    if (url === CH) return res(302, null, { location: S3 });
    s3Attempts++;
    return s3Attempts < 2 ? res(200, new Uint8Array(), { "content-length": "4" }) : res(200, PDF, { "content-length": "4" });
  }) as unknown as typeof fetch;
  const flakyBuf = await fetchChDocument(CH, "Basic KEY", { fetchImpl: flakyFetch, baseDelayMs: 0 });

  test("downloads via the S3 redirect and returns the bytes", () => {
    assert(!!okBuf && okBuf.length === 4, "returns the PDF bytes");
  });
  test("never forwards the Authorization header to S3", () => {
    assert(!s3Headers || !("Authorization" in s3Headers) && !("authorization" in s3Headers), "no auth to S3");
  });
  test("a CH 200 empty body abstains without retrying", () => {
    assertEqual(emptyBuf, null, "returns null");
    assertEqual(calls, 1, "did not hammer CH");
  });
  test("a truncated S3 body retries and then succeeds", () => {
    assert(!!flakyBuf && flakyBuf.length === 4, "recovered after a retry");
    assert(s3Attempts >= 2, "retried the S3 hop");
  });

  // 5) A declared-oversize S3 body is rejected, never buffered.
  const bigFetch = (async (url: string) => {
    if (url === CH) return res(302, null, { location: S3 });
    return res(200, PDF, { "content-length": String(999_999_999) });
  }) as unknown as typeof fetch;
  const bigBuf = await fetchChDocument(CH, "Basic KEY", { fetchImpl: bigFetch, baseDelayMs: 0, maxBytes: 1024 });
  test("rejects a document whose declared size exceeds the cap", () => {
    assertEqual(bigBuf, null, "oversize document is not downloaded");
  });

  // 6) beforeAttempt is charged before EVERY attempt (incl. retries), and a throw stops the download.
  let charged = 0;
  let s3Tries = 0;
  const retryThenBudget = (async (url: string) => {
    if (url === CH) return res(302, null, { location: S3 });
    s3Tries++;
    return res(200, new Uint8Array(), { "content-length": "4" }); // always truncated -> keeps retrying
  }) as unknown as typeof fetch;
  const chargedBuf = await fetchChDocument(CH, "Basic KEY", {
    fetchImpl: retryThenBudget,
    baseDelayMs: 0,
    maxRetries: 5,
    beforeAttempt: async () => { charged++; if (charged >= 3) throw new Error("ChBudget"); },
  });
  test("charges beforeAttempt on every attempt and stops when it throws", () => {
    assertEqual(chargedBuf, null, "returns null when the budget hook throws");
    assertEqual(charged, 3, "charged once per attempt until the hook threw on the third");
    assertEqual(s3Tries, 2, "only the two attempts that passed the budget hook hit the network");
  });
}
