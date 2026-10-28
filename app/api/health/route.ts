// app/api/health/route.ts
// A no-secrets status endpoint for uptime checks and a quick read of which scale backends
// are live. Every field is a boolean or a safe enum / literal: it reveals WHICH backend is
// configured, never any URL, key or token. Node runtime so it can read the same store /
// cache helpers the app uses.

import { dataMode, llmMode } from "@/lib/engine/pipeline";
import { storeIsDurable } from "@/lib/store/tearSheetStore";
import { cacheBackend } from "@/lib/cache/cache";
import { CONTRACT_VERSION } from "@/lib/contracts";
import { productionReadiness } from "@/lib/config/prodGuard";
import { databaseUrl } from "@/lib/store/postgres";
import { checkDbRole, roleReady } from "@/lib/db/roleGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  // Only a single readiness BOOLEAN is exposed publicly. The specific missing variable names are
  // deliberately NOT returned here: on an unauthenticated endpoint they would tell an attacker
  // exactly which security setting is absent (which spoof or poisoning attack is live). The names
  // are available to the operator through the boot logs / the prod-guard throw, not over the wire.
  const r = productionReadiness();
  // WP-DS02: an app connected as the owner (or any role that bypasses RLS) is never ready.
  const dbConfigured = Boolean(databaseUrl());
  const role = await checkDbRole();
  const body = {
    status: "ok" as const,
    contractVersion: CONTRACT_VERSION,
    dataMode: dataMode(), // "live" when CH_API_KEY set, else "fixtures"
    llm: llmMode(), // "on" when a parsing model is configured, else "off"
    storeDurable: storeIsDurable(), // true when DATABASE_URL is set
    cacheBackend: cacheBackend(), // "upstash" when KV / Upstash env set, else "memory"
    dbRoleSafe: role.safe, // true: app_user-like role. false: owner, superuser or BYPASSRLS. null: no database or no answer
    ready: r.ok && roleReady(role, dbConfigured), // secrets set (always true outside prod) and a safe database role
    region: process.env.VERCEL_REGION ?? "unknown",
    commit: process.env.VERCEL_GIT_COMMIT_SHA ?? "dev",
    time: new Date().toISOString(),
  };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}
