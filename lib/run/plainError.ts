// lib/run/plainError.ts
// What a run record says when something threw. The record is read by a person, so transport
// errors are put into words (WP-BE14): QA04 found "The run stopped at resolve: fetch failed" and
// "This operation was aborted" on the record, which are undici's words, not ours. An error our
// own code wrote in plain words is kept as it is.

import { ChUnreachableError, isTransientNetworkError } from "../sources/chHttp";

export function explainRunError(e: unknown): string {
  if (e instanceof ChUnreachableError) return e.message;
  if (e instanceof Error && isTransientNetworkError(e)) {
    const timedOut = e.name === "AbortError" || e.name === "TimeoutError" || /aborted|timed? ?out/i.test(e.message);
    return timedOut
      ? "A source did not answer in time (a network timeout). Nothing was learned from it; this is not an answer about the company. Try again in a minute."
      : "A source could not be reached (a network error). Nothing was learned from it; this is not an answer about the company. Try again in a minute.";
  }
  return e instanceof Error ? e.message : String(e);
}
