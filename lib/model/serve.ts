// lib/model/serve.ts
// The model download, minus the request plumbing, so it can be tested with no request context.
// app/api/model/[key]/route.ts resolves the tenant and the rate limit and hands over here.
//
// Keyed by run id or by sheet key, and tenant scoped either way:
//   - a run id is looked up in the tenant's run store; a finished run names its sheet key;
//   - a sheet key is loaded from the tenant's workspace (lib/workspace.ts getTearSheet), which
//     is where a live Companies House, ESEF or SEC run saved it. This is what fixed the 404 on a
//     saved real sheet such as /sheet/sec-aapl: the route used to call tearSheetForKey, which
//     knows only the bundled demo fixtures.
//
// Answers, in the words the rest of the API uses:
//   401 no tenant (signed out with AUTH_REQUIRED=1), the same body WP-FE01's middleware sends;
//   404 a key or run id this tenant does not hold, whether or not another tenant does;
//   409 a run of this tenant's that has not produced a sheet (still running, needs a choice,
//       failed before saving);
//   200 the workbook.
//
// There is no cache of built workbooks any more. The sheet has to be loaded from the tenant's
// store on every request anyway, to prove it is the caller's, and building the workbook from it
// takes milliseconds. A shared cache of tenant workbooks was one more place for a key to leak.

import { getTearSheet } from "../workspace";
import { getRunStore, type RunStore } from "../run/store";
import { buildModelWorkbook } from "./buildWorkbook";

export const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export interface ServeModelDeps {
  runStore?: RunStore;
}

function json(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export function modelFilename(companyName: string): string {
  const s = companyName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${s || "tear-sheet"}-model.xlsx`;
}

export async function serveModel(tenantId: string, keyOrRunId: string, deps: ServeModelDeps = {}): Promise<Response> {
  if (!tenantId) return json({ error: "Sign in required." }, 401);
  const id = keyOrRunId.trim();
  if (!id) return json({ error: "No such sheet." }, 404);

  // A run id first. Run ids and sheet keys never collide: a sheet key is a fixture key or a
  // source-prefixed slug, a run id is the runner's own id. A store that cannot read the id as a
  // run (a durable store with a typed id column) means it is not a run, so it is tried as a key.
  let sheetKey = id;
  let runId: string | undefined;
  const run = await (deps.runStore ?? getRunStore()).load(tenantId, id).catch(() => null);
  if (run) {
    if (!run.sheetKey) {
      return json(
        {
          error: "This run has not produced a sheet, so there is no model to download.",
          status: run.status,
          reason: run.reason,
        },
        409,
      );
    }
    sheetKey = run.sheetKey;
    runId = run.id;
  }

  const resolved = await getTearSheet(tenantId, sheetKey);
  if (!resolved) return json({ error: "No such sheet." }, 404);

  const buf = await buildModelWorkbook(resolved.ts, { sheetKey, runId });
  return new Response(new Uint8Array(buf as ArrayBuffer), {
    status: 200,
    headers: {
      "content-type": XLSX_TYPE,
      "content-disposition": `attachment; filename="${modelFilename(resolved.ts.entity.companyName)}"`,
      // Tenant data: never stored by a shared cache.
      "cache-control": "private, no-store",
    },
  });
}
