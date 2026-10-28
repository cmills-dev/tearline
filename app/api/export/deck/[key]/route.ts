// app/api/export/deck/[key]/route.ts
// The branded deck for a run id or a saved sheet key, scoped to the caller's tenant:
//   GET /api/export/deck/<key>             the deck, 16:9 landscape pages, to read or print
//   GET /api/export/deck/<key>?print=1     the same, opening the print dialog (save as PDF)
//   GET /api/export/deck/<key>?download=1  the same HTML as an attachment
// Everything past the tenant and the rate limit lives in lib/deck/serve.ts, where it is tested:
// 401 signed out, 404 for a key or run this tenant does not hold, 409 for a run with no sheet yet.

import { getTenantId } from "@/lib/tenant";
import { serveDeck } from "@/lib/deck/serve";
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
  const rl = await limiter.check(`deck:${ip}`, RATE_LIMIT, RATE_WINDOW);
  if (!rl.ok) {
    return new Response("Too many requests. Please retry shortly.", {
      status: 429,
      headers: { "Retry-After": String(rl.resetSeconds), "Cache-Control": "no-store" },
    });
  }

  const tenantId = await getTenantId();
  const { key } = await params;
  const q = new URL(req.url).searchParams;
  return serveDeck(tenantId, key, { print: q.get("print") === "1", download: q.get("download") === "1" });
}
