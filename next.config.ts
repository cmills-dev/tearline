import type { NextConfig } from "next";
import { STATIC_SECURITY_HEADERS } from "./lib/http/csp";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // No X-Powered-By: Next.js on any response (WP-QA05).
  poweredByHeader: false,
  // The database client is loaded with a webpackIgnore dynamic import (lib/store/postgres.ts
  // and its siblings), so the bundler never sees it. This makes the file tracer copy it into
  // every server function anyway. Without it a Vercel deploy fails on its first query.
  outputFileTracingIncludes: {
    "/**": ["./node_modules/postgres/**"],
  },
  // The static security headers on every host, not only Vercel (lib/http/csp.ts). The
  // Content-Security-Policy is per request, so it is set in middleware.ts.
  async headers() {
    return [{ source: "/:path*", headers: STATIC_SECURITY_HEADERS }];
  },
};

export default nextConfig;
