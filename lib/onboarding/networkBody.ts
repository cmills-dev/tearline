// lib/onboarding/networkBody.ts
// The body of POST /api/onboarding/network, checked before anything is written. A body with no
// relationships array (null, {}, a number, or relationships of the wrong type) is refused
// (WP-QA05): it used to seed nothing and still mark the "network" step complete. An empty array
// is a real answer, the wizard's "no relationships to add", and still completes the step.

// Input caps: a firm node seeds one graph node/edge per stated relationship, so an unbounded
// relationships array is an unbounded write. Cap the count and the free-text lengths; anything
// over the cap is dropped (reported in the response), never silently written in full.
export const MAX_RELATIONSHIPS = 500;
export const MAX_FIRM_NAME = 200;

export type NetworkBody =
  | { ok: true; firmName: string; relationships: unknown[]; droppedRelationships: number }
  | { ok: false; error: string };

export function readNetworkBody(body: { firmName?: unknown; relationships?: unknown }): NetworkBody {
  if (!Array.isArray(body.relationships)) {
    return { ok: false, error: "relationships must be a list (an empty list if there are none)." };
  }
  const firmName = typeof body.firmName === "string" ? body.firmName.trim().slice(0, MAX_FIRM_NAME) : "";
  const relationships = body.relationships.slice(0, MAX_RELATIONSHIPS);
  return { ok: true, firmName, relationships, droppedRelationships: body.relationships.length - relationships.length };
}
