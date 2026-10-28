// app/api/model/[key]/route.ts
// Streams a real .xlsx credit / leverage model for a run id or a saved sheet key, scoped to the
// caller's tenant. exceljs needs the Node runtime (not edge). The workbook is built from the SAME
// assembled TearSheet the web view renders, so the download can never diverge from what is on
// screen. Everything past the tenant and the rate limit lives in lib/model/serve.ts, where it is
// tested: 401 signed out, 404 for a key or run this tenant does not hold, 409 for a run with no
// sheet yet.
//
// Per-IP rate limiting (c. 30 / min, env-only flip to a shared backend) so one client cannot
// hammer the workbook build.

import { getTenantId } from "@/lib/tenant";
import { serveModel } from "@/lib/model/serve";
import { getRateLimiter, clientIp } from "@/lib/ratelimit/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RATE_LIMIT = 30; // requests
const RATE_WINDOW = 60; // seconds

export async function GET(
  req: Request,
  { params }: { params: Promise<{ key: string }> }
): Promise<Response> {
  // Per-IP rate limit. On exceed return 429 with a Retry-After header.
  const limiter = getRateLimiter();
  const ip = clientIp(req.headers);
  const rl = await limiter.check(`model:${ip}`, RATE_LIMIT, RATE_WINDOW);
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
  return serveModel(tenantId, key);
}
