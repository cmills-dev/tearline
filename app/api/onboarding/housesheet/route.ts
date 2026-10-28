// app/api/onboarding/housesheet/route.ts
// Renders the tenant's ACTIVE ClientSpec against a fact manifest and returns the spec-conformed
// sheet as JSON. This lives as a route handler (not read directly in the page's server component)
// on purpose: a route handler shares the same module runtime as the activate route, so a spec just
// activated in memory is visible here immediately, even without a database.
//
// Source of facts (the Module 1 <-> Module 2 join):
//   - default: the demo borrower Meridian's single-source manifest.
//   - ?entity=<masterId>: the KNOWLEDGE GRAPH's accumulated cross-source facts for that master
//     entity, so the client's house sheet renders from EVERY source at once, with a known-unknowns
//     panel naming the fields their spec wants that the graph cannot support.
// The renderer is identical either way; only the manifest differs.

import { NextResponse } from "next/server";
import { getTenantId } from "@/lib/tenant";
import { getClientSpecStore } from "@/lib/clientspec/store";
import { renderAgainstSpec } from "@/lib/clientspec/render";
import { manifestForKey } from "@/lib/engine/pipeline";
import { getKbStore } from "@/lib/kb/kbStore";
import { buildKbManifest } from "@/lib/kb/kbManifest";
import { knownUnknowns } from "@/lib/kb/knownUnknowns";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const tenantId = await getTenantId();
  if (!tenantId) return NextResponse.json({ error: "You must be signed in." }, { status: 401 });

  const spec = await getClientSpecStore().getActiveSpec(tenantId);
  if (!spec) return NextResponse.json({ hasSpec: false, sheet: null });

  const entityId = new URL(req.url).searchParams.get("entity");

  if (entityId) {
    // Render the client's spec against the knowledge graph's accumulated facts for this entity.
    const store = getKbStore();
    const manifest = await buildKbManifest(store, entityId);
    if (!manifest) return NextResponse.json({ hasSpec: true, sheet: null, note: "No such entity in the knowledge graph." });
    const [sheet, gaps] = await Promise.all([
      Promise.resolve(renderAgainstSpec(spec, manifest)),
      knownUnknowns(store, entityId),
    ]);
    return NextResponse.json({ hasSpec: true, sheet, source: "kb", entityId, knownUnknowns: gaps });
  }

  // Default: the single-source demo manifest.
  const manifest = manifestForKey("meridian");
  const sheet = manifest ? renderAgainstSpec(spec, manifest) : null;
  return NextResponse.json({ hasSpec: true, sheet, source: "demo" });
}
