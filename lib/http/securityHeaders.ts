// securityHeaders (WP-QA06 S2, reconciled with WP-QA05 in merge/overnight-0928)
// The full set of security headers a app page receives. It is not a second policy: the headers come
// from ./csp.ts. STATIC_SECURITY_HEADERS go out from next.config.ts on every response, and the
// Content-Security-Policy is set per request in middleware.ts with a fresh nonce. QA06 had built
// an 'unsafe-inline' policy set from next.config.ts. The build already carried QA05's stricter
// nonce policy, so the merge kept that one and this module now only describes it.

import { buildCsp, newNonce, STATIC_SECURITY_HEADERS } from "./csp";

export interface Header {
  key: string;
  value: string;
}

export function contentSecurityPolicy(env: { NODE_ENV?: string } = process.env): string {
  return buildCsp(newNonce(), { dev: env.NODE_ENV === "development" });
}

export function securityHeaders(env: { NODE_ENV?: string } = process.env): Header[] {
  return [{ key: "Content-Security-Policy", value: contentSecurityPolicy(env) }, ...STATIC_SECURITY_HEADERS];
}
