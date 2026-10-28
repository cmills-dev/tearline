// lib/sources/fetchDoc.ts
// Robust Companies House document download. The CH content endpoint 302-redirects to a
// pre-signed AWS S3 URL. Two rules make this reliable:
//   1. The Authorization header goes ONLY to Companies House (hop 1). It must NOT be
//      forwarded to S3, which rejects a request that carries both a pre-signed query
//      signature and an Authorization header ("only one auth mechanism") - the class of
//      empty-body failure we saw. So hop 2 (S3) carries bare headers.
//   2. redirect:'manual' on hop 1 (never 'follow'): undici preserves Authorization across
//      a followed redirect and would leak it to S3.
// Plus retry/backoff on transient failures and truncation, and an exact abstain-vs-retry
// split: a CH 200 with an empty body means "document not available" (abstain, do not
// hammer); a 302 -> S3 with an empty/short body means truncation (retry).

export interface FetchDocOptions {
  accept?: string;
  maxRetries?: number;
  timeoutMs?: number;
  baseDelayMs?: number;
  maxBytes?: number; // hard cap on the downloaded document size (default 64MB)
  // Called before EACH attempt (incl. retries). Wire this to assertChBudget so every CH hop this
  // download makes - including retries - is charged to the shared budget, not just the first. If it
  // throws (e.g. ChBudgetError), the download stops and returns null (this helper never throws).
  beforeAttempt?: () => Promise<void>;
  // Injectable for tests; defaults to global fetch.
  fetchImpl?: typeof fetch;
}

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Attempt =
  | { kind: "ok"; buf: Uint8Array }
  | { kind: "retry" }
  | { kind: "abstain" } // definitively not available; do not retry
  | { kind: "fail" };

async function once(
  contentUrl: string,
  authHeader: string,
  accept: string,
  timeoutMs: number,
  maxBytes: number,
  doFetch: typeof fetch,
): Promise<Attempt> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  // A declared content-length over the cap fails immediately; a body without a declared length is
  // bounded after the read (below). Either way an oversized document never passes through.
  const tooBig = (res: Response) => Number(res.headers.get("content-length") || "0") > maxBytes;
  try {
    const hop1 = await doFetch(contentUrl, {
      headers: { Authorization: authHeader, Accept: accept },
      redirect: "manual",
      signal: ctrl.signal,
    } as RequestInit);

    if (hop1.status >= 300 && hop1.status < 400) {
      const loc = hop1.headers.get("location");
      if (!loc) return { kind: "fail" };
      // S3 hop: BARE headers. No Authorization, no bespoke Accept.
      const hop2 = await doFetch(loc, { signal: ctrl.signal } as RequestInit);
      if (RETRY_STATUS.has(hop2.status)) return { kind: "retry" };
      if (!hop2.ok) return { kind: "fail" };
      if (tooBig(hop2)) return { kind: "fail" }; // declared oversize -> reject, do not buffer
      const declared = Number(hop2.headers.get("content-length") || "0");
      const buf = new Uint8Array(await hop2.arrayBuffer());
      if (buf.length > maxBytes) return { kind: "fail" }; // undeclared oversize
      if (buf.length === 0) return { kind: "retry" }; // truncated / empty from S3 -> retry
      if (declared > 0 && buf.length < declared) return { kind: "retry" }; // short read
      return { kind: "ok", buf };
    }

    if (RETRY_STATUS.has(hop1.status)) return { kind: "retry" };
    if (hop1.ok) {
      if (tooBig(hop1)) return { kind: "fail" };
      const buf = new Uint8Array(await hop1.arrayBuffer());
      if (buf.length > maxBytes) return { kind: "fail" };
      // CH answered 200 directly with nothing: the document is not available. Abstain
      // rather than retry (retrying a genuine 200-empty just wastes CH rate budget).
      if (buf.length === 0) return { kind: "abstain" };
      return { kind: "ok", buf };
    }
    return { kind: "fail" };
  } catch {
    // Network error / timeout / abort: transient, retry.
    return { kind: "retry" };
  } finally {
    clearTimeout(timer);
  }
}

// Download a CH document as bytes, or null when it is not available. Never throws.
export async function fetchChDocument(
  contentUrl: string,
  authHeader: string,
  opts: FetchDocOptions = {},
): Promise<Uint8Array | null> {
  const accept = opts.accept ?? "application/pdf";
  const maxRetries = opts.maxRetries ?? 4;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const baseDelayMs = opts.baseDelayMs ?? 250;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const doFetch = opts.fetchImpl ?? fetch;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Charge the budget for THIS attempt (a CH hop) before making it, so retries are counted too.
    // A thrown budget error stops the download; this helper's never-throw contract is preserved.
    if (opts.beforeAttempt) {
      try {
        await opts.beforeAttempt();
      } catch {
        return null;
      }
    }
    const res = await once(contentUrl, authHeader, accept, timeoutMs, maxBytes, doFetch);
    if (res.kind === "ok") return res.buf;
    if (res.kind === "abstain" || res.kind === "fail") return null;
    // retry with exponential backoff + jitter
    if (attempt < maxRetries) {
      const delay = baseDelayMs * 2 ** attempt + Math.floor(Math.random() * baseDelayMs);
      await sleep(delay);
    }
  }
  return null;
}
