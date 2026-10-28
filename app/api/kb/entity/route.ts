// app/api/kb/entity/route.ts
// One master entity's cross-source coverage (Module 2). GET ?id=<masterId> returns the entity
// and its accumulated coverage: per metric+period, which sources hold it, the freshest as-of and
// the resolution rung. Shared Tier-0 plane, so not tenant-scoped.

import { NextResponse } from "next/server";
import { getKbStore } from "@/lib/kb/kbStore";
import { knownUnknowns } from "@/lib/kb/knownUnknowns";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const store = getKbStore();
  const entity = await store.getEntity(id);
  if (!entity) return NextResponse.json({ error: "No such entity" }, { status: 404 });

  const [coverage, instruments, gaps] = await Promise.all([
    store.coverage(id),
    store.listInstruments(id),
    knownUnknowns(store, id),
  ]);

  return NextResponse.json({
    entity: {
      masterId: entity.masterId,
      primaryName: entity.names[0] ?? entity.identifiers.name,
      sources: entity.sources,
      identifiers: entity.identifiers,
    },
    coverage,
    instruments,
    knownUnknowns: gaps,
  });
}
