"use server";

// Server actions for the live origination panel. The suggestion store is tenant-scoped
// and server-side, so saving a shortlist must round-trip through the server; the client
// panel calls these and re-renders from the returned list.

import { getTenantId } from "@/lib/tenant";
import { saveSuggestion, listSuggestions, type SavedSuggestion } from "@/lib/workspace";
import { getGraphStore } from "@/lib/graph/store";
import { originateForTarget } from "@/lib/originate/live";
import type { MandateLike } from "@/lib/originate/signals";
import { textField } from "@/lib/http/body";

export interface SaveShortlistResult {
  list: SavedSuggestion[];
  saved: SavedSuggestion | null;
  note?: string;
}

// Save a shortlist for the signed-in tenant. Crucially, the suggestion is RE-DERIVED on the
// server from the engine (never taken from the client), so a saved record can only ever contain
// engine-produced, cited content: a crafted client payload cannot smuggle a fabricated why-now or
// warm path into the workspace. If the engine now abstains, nothing is saved and we say so.
export async function saveShortlistAction(input: {
  chNumber: string;
  mandate?: MandateLike;
}): Promise<SaveShortlistResult> {
  const tenantId = await getTenantId();
  if (!tenantId) throw new Error("You must be signed in to save a shortlist.");
  const chNumber = textField(input?.chNumber).trim();
  if (!chNumber) throw new Error("A Companies House number is required.");

  const suggestion = await originateForTarget(tenantId, chNumber, input.mandate ?? {}, getGraphStore());
  if (!suggestion) {
    return { list: await listSuggestions(tenantId), saved: null, note: "No cited catalyst - nothing saved." };
  }
  const saved = await saveSuggestion(tenantId, suggestion);
  return { list: await listSuggestions(tenantId), saved };
}

// Read the tenant's current shortlists (used to refresh after a save elsewhere).
export async function listShortlistsAction(): Promise<SavedSuggestion[]> {
  const tenantId = await getTenantId();
  if (!tenantId) return [];
  return listSuggestions(tenantId);
}
