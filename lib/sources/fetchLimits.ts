// lib/sources/fetchLimits.ts
// A small wrapper around fetch that bounds two DoS/OOM surfaces every upstream source shares:
//   - a TIMEOUT (AbortController), so a slow or hung upstream cannot pin a request open; and
//   - a hard SIZE CAP enforced while STREAMING the body, so an oversized or chunked response
//     (SEC companyfacts JSON is tens of MB, ESEF facts JSON 100MB+) cannot be buffered whole and
//     exhaust memory. The cap is checked against content-length up front AND enforced byte-by-byte
//     as chunks arrive, so an undeclared/chunked body is bounded too.
// The caps are set ABOVE the largest legitimate payload for each source, so they never bite real
// data; they exist only to stop a pathological or malicious response, not to trim normal ones.

export interface FetchLimitOptions {
  timeoutMs?: number;
  maxBytes?: number;
  headers?: Record<string, string>;
  accept?: string;
  fetchImpl?: typeof fetch;
}

export const MB = 1024 * 1024;

// Thrown when a response exceeds the size cap (declared or streamed). Typed so a caller can tell an
// oversize body from an ordinary network error if it wants to.
export class ResponseTooLargeError extends Error {
  constructor(readonly bytes: number, readonly cap: number) {
    super(`Response body exceeded the ${cap}-byte cap (saw ${bytes}+ bytes)`);
    this.name = "ResponseTooLargeError";
  }
}

export interface LimitedResponse {
  ok: boolean;
  status: number;
  text: string;
  // The Retry-After header, when the upstream sent one (WP-BE14: chHttp honours it on a 429).
  retryAfter?: string | null;
}

// Read a response body as text, never accumulating more than maxBytes. Uses the streaming reader
// when available (so a huge body is aborted mid-stream, not after buffering); falls back to text().
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const body = res.body;
  if (!body || typeof body.getReader !== "function") {
    const text = await res.text();
    if (text.length > maxBytes) throw new ResponseTooLargeError(text.length, maxBytes);
    return text;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ResponseTooLargeError(total, maxBytes);
      }
      out += decoder.decode(value, { stream: true });
    }
  }
  out += decoder.decode();
  return out;
}

// Fetch a URL as text with a timeout and a hard size cap. Throws on a timeout/abort (a transient
// network error, same as fetch) or ResponseTooLargeError; returns the status so the caller decides
// how to treat a non-2xx.
export async function fetchTextLimited(url: string, opts: FetchLimitOptions = {}): Promise<LimitedResponse> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxBytes = opts.maxBytes ?? 64 * MB;
  const doFetch = opts.fetchImpl ?? fetch;
  const headers = { ...(opts.headers ?? {}), ...(opts.accept ? { Accept: opts.accept } : {}) };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await doFetch(url, { headers, signal: ctrl.signal, cache: "no-store" } as RequestInit);
    const declared = Number(res.headers?.get?.("content-length") || "0");
    if (declared > maxBytes) throw new ResponseTooLargeError(declared, maxBytes);
    const text = await readCapped(res, maxBytes);
    return { ok: res.ok, status: res.status, text, retryAfter: res.headers?.get?.("retry-after") ?? null };
  } finally {
    clearTimeout(timer);
  }
}

// Fetch and parse JSON with the same timeout + size cap. Throws on a non-2xx (message includes the
// status and url), a timeout, an oversize body, or malformed JSON.
export async function fetchJsonLimited<T>(url: string, opts: FetchLimitOptions = {}): Promise<T> {
  const res = await fetchTextLimited(url, { accept: "application/json", ...opts });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return JSON.parse(res.text) as T;
}
