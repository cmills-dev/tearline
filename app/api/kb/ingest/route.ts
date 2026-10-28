// app/api/kb/ingest/route.ts
// Demo ingest into the knowledge graph (Module 2). POST { key } builds a fixture manifest and
// ingests it onto the master-ID spine. The two Meridian keys share a fixed demo LEI and are
// ingested as DIFFERENT sources ("companies-house" and "esef"), so they resolve to ONE master
// entity whose coverage then carries facts from both, demonstrating cross-source accumulation.
// Only fixture keys are accepted, so the input is bounded. The plane is shared Tier-0 (public).

import { NextResponse } from "next/server";
import { readJsonObject } from "@/lib/http/body";
import { manifestForKey } from "@/lib/engine/pipeline";
import { getKbStore } from "@/lib/kb/kbStore";
import { ingestManifest } from "@/lib/kb/ingest";
import type { EntityIdentifiers } from "@/lib/kb/kbTypes";

export const dynamic = "force-dynamic";

// A stable demo LEI so the two Meridian ingests (two sources) merge to one entity.
const MERIDIAN_DEMO_LEI = "MERIDIANDEMO000000LEI";

interface DemoSource {
  fixtureKey: string;
  source: string;
  idsOverride?: Partial<EntityIdentifiers>;
}

const DEMO: Record<string, DemoSource> = {
  meridian: { fixtureKey: "meridian", source: "companies-house", idsOverride: { lei: MERIDIAN_DEMO_LEI } },
  "meridian-esef": { fixtureKey: "meridian", source: "esef", idsOverride: { lei: MERIDIAN_DEMO_LEI } },
  redacta: { fixtureKey: "redacta", source: "companies-house" },
};

export async function POST(req: Request) {
  const body = (await readJsonObject(req)) as { key?: string };
  const demo = body.key ? DEMO[body.key] : undefined;
  if (!demo) return NextResponse.json({ error: "Unknown ingest key." }, { status: 400 });

  const manifest = manifestForKey(demo.fixtureKey);
  if (!manifest) return NextResponse.json({ error: "Fixture manifest unavailable." }, { status: 404 });

  const result = await ingestManifest(getKbStore(), manifest, demo.source, demo.idsOverride);
  return NextResponse.json(result);
}
