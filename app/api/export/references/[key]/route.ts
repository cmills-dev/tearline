// app/api/export/references/[key]/route.ts
// The references pack for a run id or a saved sheet key, scoped to the caller's tenant:
//   GET /api/export/references/<key>              the HTML pack
//   GET /api/export/references/<key>?format=csv   its CSV twin
// Everything past the tenant and the rate limit lives in lib/references/serve.ts, where it is
// tested: 401 signed out, 404 for a key or run this tenant does not hold, 409 for a run with no
// sheet yet, 400 for an unknown format.

import { getTenantId } from "@/lib/tenant";
import { serveReferences } from "@/lib/references/serve";
import { getRateLimiter, clientIp } from "@/lib/ratelimit/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RATE_LIMIT = 30; // requests
const RATE_WINDOW = 60; // seconds

export async function GET(
  req: Request,
  { params }: { params: Promise<{ key: string }> }
): Promise<Response> {
  const limiter = getRateLimiter();
  const ip = clientIp(req.headers);
  const rl = await limiter.check(`references:${ip}`, RATE_LIMIT, RATE_WINDOW);
  if (!rl.ok) {
    return new Response("Too many requests. Please retry shortly.", {
      status: 429,
      headers: {
        "Retry-After": String(rl.resetSeconds),
        "Cache-Control": "no-store",
      },
    });
  }

  const tenantId = await getTenantId();
  const { key } = await params;
  const format = new URL(req.url).searchParams.get("format");
  return serveReferences(tenantId, key, format);
}
