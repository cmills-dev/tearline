// lib/references/serve.ts
// The references pack download, minus the request plumbing, so it can be tested with no request
// context. app/api/export/references/[key]/route.ts resolves the tenant and the rate limit and
// hands over here. It follows lib/model/serve.ts (WP-BE07) answer for answer:
//
//   401 no tenant (signed out with AUTH_REQUIRED=1);
//   404 a key or run id this tenant does not hold, whether or not another tenant does;
//   409 a run of this tenant's that has not produced a sheet yet;
//   400 a format other than html or csv;
//   200 the pack, as an attachment, never stored by a shared cache.
//
// Keyed by run id or by sheet key. A run id is looked up in the tenant's run store and a finished
// run names its sheet key. The sheet is then loaded from the tenant's workspace, the same call the
// sheet page makes, so the pack lists exactly the figures the reader saw.

import { getTearSheet } from "../workspace";
import { getRunStore, type RunStore } from "../run/store";
import { buildReferencesPack } from "./pack";

export type ReferencesFormat = "html" | "csv";

export interface ServeReferencesDeps {
  runStore?: RunStore;
  now?: () => Date;
}

function json(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export function parseFormat(raw: string | null | undefined): ReferencesFormat | null {
  const f = (raw ?? "html").trim().toLowerCase();
  return f === "html" || f === "csv" ? f : null;
}

export async function serveReferences(
  tenantId: string,
  keyOrRunId: string,
  format: string | null | undefined,
  deps: ServeReferencesDeps = {}
): Promise<Response> {
  if (!tenantId) return json({ error: "Sign in required." }, 401);
  const fmt = parseFormat(format);
  if (!fmt) return json({ error: "Format must be html or csv." }, 400);
  const id = keyOrRunId.trim();
  if (!id) return json({ error: "No such sheet." }, 404);

  let sheetKey = id;
  let runId: string | undefined;
  const run = await (deps.runStore ?? getRunStore()).load(tenantId, id).catch(() => null);
  if (run) {
    if (!run.sheetKey) {
      return json(
        {
          error: "This run has not produced a sheet, so there is no references pack to download.",
          status: run.status,
          reason: run.reason,
        },
        409
      );
    }
    sheetKey = run.sheetKey;
    runId = run.id;
  }

  const resolved = await getTearSheet(tenantId, sheetKey);
  if (!resolved) return json({ error: "No such sheet." }, 404);

  const pack = buildReferencesPack(resolved.ts, {
    sheetKey,
    runId,
    generatedAt: (deps.now ?? (() => new Date()))().toISOString(),
  });
  const body = fmt === "csv" ? pack.csv : pack.html;
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": fmt === "csv" ? "text/csv; charset=utf-8" : "text/html; charset=utf-8",
      "content-disposition": `attachment; filename="${pack.filenameBase}.${fmt}"`,
      "x-references-pack-hash": pack.packHash,
      // The HTML carries no script and needs none. Opened inline by mistake, it still cannot run any.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'",
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    },
  });
}
