// lib/deck/serve.ts
// The deck download, minus the request plumbing, so it can be tested with no request context.
// app/api/export/deck/[key]/route.ts resolves the tenant and the rate limit and hands over here.
// It answers exactly as lib/references/serve.ts (WP-BE11) and lib/model/serve.ts (WP-BE07) do:
//
//   401 no tenant (signed out with AUTH_REQUIRED=1);
//   404 a key or run id this tenant does not hold, whether or not another tenant does;
//   409 a run of this tenant's that has not produced a sheet yet;
//   200 the deck as HTML, laid out as 16:9 landscape pages, never stored by a shared cache.
//
// Deck format: a print route, because Cam's PDF-or-PPTX call (backlog, Wed 16 Sep 12:00) is not
// recorded and a print route needs no new dependency. `?print=1` adds one inline script that opens
// the print dialog, allowed by its hash alone. `?download=1` sends it as an attachment instead.

import { getTearSheet } from "../workspace";
import { getRunStore, type RunStore } from "../run/store";
import { getStore } from "../store/tearSheetStore";
import { detectSignals, type Signal } from "../originate/signals";
import { buildDeck } from "./slides";
import { deckCsp, renderDeckHtml } from "./html";

export interface ServeDeckDeps {
  runStore?: RunStore;
  now?: () => Date;
}

function json(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export async function serveDeck(
  tenantId: string,
  keyOrRunId: string,
  flags: { print?: boolean; download?: boolean } = {},
  deps: ServeDeckDeps = {}
): Promise<Response> {
  if (!tenantId) return json({ error: "Sign in required." }, 401);
  const id = keyOrRunId.trim();
  if (!id) return json({ error: "No such sheet." }, 404);

  let sheetKey = id;
  let runId: string | undefined;
  const run = await (deps.runStore ?? getRunStore()).load(tenantId, id).catch(() => null);
  if (run) {
    if (!run.sheetKey) {
      return json(
        { error: "This run has not produced a sheet, so there is no deck to build.", status: run.status, reason: run.reason },
        409
      );
    }
    sheetKey = run.sheetKey;
    runId = run.id;
  }

  const resolved = await getTearSheet(tenantId, sheetKey);
  if (!resolved) return json({ error: "No such sheet." }, 404);

  // Catalysts come from the saved manifest. getTearSheet has just saved it if it was not stored.
  let signals: Signal[] = [];
  const manifest = await getStore().load(tenantId, sheetKey).catch(() => null);
  if (manifest) signals = detectSignals(manifest).signals;

  const deck = buildDeck(resolved.ts, {
    sheetKey,
    runId,
    generatedAt: (deps.now ?? (() => new Date()))().toISOString(),
    signals,
  });
  const autoprint = flags.print === true && flags.download !== true;
  const headers: Record<string, string> = {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": deckCsp(autoprint),
    "x-content-type-options": "nosniff",
    "cache-control": "private, no-store",
  };
  if (flags.download) headers["content-disposition"] = `attachment; filename="${deck.filenameBase}.html"`;
  return new Response(renderDeckHtml(deck, { autoprint }), { status: 200, headers });
}
