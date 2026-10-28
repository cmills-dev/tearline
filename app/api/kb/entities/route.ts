// app/api/kb/entities/route.ts
// The knowledge graph's master-entity list (Module 2). Reads the shared Tier-0 plane, so it is
// not tenant-scoped: public entities are shared. Returns each entity's master id, primary name,
// contributing sources and external identifiers, for the /kb browser.

import { NextResponse } from "next/server";
import { getKbStore } from "@/lib/kb/kbStore";

export const dynamic = "force-dynamic";

export async function GET() {
  const entities = await getKbStore().listEntities();
  return NextResponse.json({
    entities: entities.map((e) => ({
      masterId: e.masterId,
      primaryName: e.names[0] ?? e.identifiers.name,
      sources: e.sources,
      identifiers: { chNumber: e.identifiers.chNumber, cik: e.identifiers.cik, lei: e.identifiers.lei },
    })),
  });
}
