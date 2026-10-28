// lib/http/body.ts
// Reading a JSON request body into something a route can index without crashing.
//
// Every POST route used `(await req.json().catch(() => ({}))) as T` and then read `body.x`.
// The catch covers a body that is not JSON at all, but not one that IS JSON and not an object:
// `null` parses, so `body.x` threw a TypeError and the route answered a bare 500 (WP-QA03 F2).
// And a field typed `string` arrived as whatever the caller sent, so `{"input": 1}` reached
// `.trim()` and threw the same way.

import { MAX_BODY_BYTES } from "./requestGuard";

// The parsed body when it is a plain JSON object; an empty object for anything else (not JSON,
// null, an array, a number or a string), so a route's own "field is required" answer applies.
// A body past MAX_BODY_BYTES reads as {} too: the middleware refuses one that declares its length,
// and this stops one that does not (chunked) from being buffered whole (WP-QA06 S5).
export async function readJsonObject<T extends object>(req: Request): Promise<Partial<T>> {
  const text = await readCappedText(req, MAX_BODY_BYTES);
  let parsed: unknown = null;
  if (text !== null) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as Partial<T>;
}

// A field the route expects to be text: the string itself, or "" for anything else, so a
// number or an object where a name belongs reads as missing rather than reaching `.trim()`.
export function textField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// The body as text, or null when it is missing or longer than maxBytes. Reads the stream and
// stops at the cap, so an oversized body is never held in memory whole.
export async function readCappedText(req: Request, maxBytes: number): Promise<string | null> {
  if (!req.body) return null;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
