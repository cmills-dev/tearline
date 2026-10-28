// lib/http/csp.ts
// The security headers the app sends on every host, not only on Vercel (WP-QA05).
//
// Two halves:
//   - STATIC_SECURITY_HEADERS go out from next.config.ts headers(), so `next start`, a container
//     or any other host sends them. They used to live in vercel.json only, which `next start`
//     ignores, so the local preview sent none of them.
//   - The Content-Security-Policy carries a fresh nonce per request, so it is set in
//     middleware.ts. Next reads the nonce off the request's CSP header and stamps it on its own
//     inline scripts. That only works for pages rendered per request, which is why the root
//     layout is force-dynamic.
//
// The policy is strict on scripts: only same-origin files and nonce-carrying inline scripts,
// and 'strict-dynamic' so a nonce-loaded chunk may load the next chunk. Styles allow inline,
// because React renders style props as style attributes and a nonce cannot cover those.
// Development adds 'unsafe-eval' for React's dev tooling and nothing else.

// Two years, as Vercel sends by default. smoke-prod wants at least 180 days.
export const HSTS = "max-age=63072000; includeSubDomains";

export const STATIC_SECURITY_HEADERS: { key: string; value: string }[] = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Strict-Transport-Security", value: HSTS },
];

export function buildCsp(nonce: string, opts: { dev?: boolean } = {}): string {
  const script = ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"];
  if (opts.dev) script.push("'unsafe-eval'");
  return [
    "default-src 'self'",
    `script-src ${script.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join("; ");
}

// 128 random bits, base64. Web Crypto, because middleware runs on the edge runtime.
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
