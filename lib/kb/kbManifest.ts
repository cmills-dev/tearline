// lib/kb/kbManifest.ts
// The bridge between Module 2 (the data graph) and Module 1 (the client house sheet): assemble a
// FactManifest-shaped view of a master entity's ACCUMULATED live facts, so the existing
// spec renderer (lib/clientspec/render.renderAgainstSpec) can draw a client's house sheet from the
// KB graph, populated from EVERY source at once, instead of from a single source manifest.
//
// It reads only live (non-superseded) facts and never mutates a value. Where two sources
// corroborate the same metric and period, one fact is chosen for rendering by the best resolution
// rung (the corroboration itself stays visible in the KB coverage view); the rendered figure is
// still the real reported value, cited to its source.

import type { KbStore, KbFactRecord } from "./kbTypes";
import type { EntityMeta, Fact, FactManifest, ProvenanceTag, SourceDocument } from "../engine/types";

const RUNG_RANK: Record<string, number> = { R1: 0, R2: 1, R3: 2, R4: 3 };

export async function buildKbManifest(store: KbStore, masterId: string): Promise<FactManifest | null> {
  const entity = await store.getEntity(masterId);
  if (!entity) return null;
  const facts = await store.listFacts(masterId); // live only

  // One fact per (metric, period): where sources corroborate, keep the best-rung record, and on an
  // equal rung the FRESHEST (max asOf), so a stale value never renders over a newer corroborating
  // one. Falls back to insertion order only when rung and asOf are both equal.
  const asOfMs = (s: string): number => {
    const t = Date.parse(s);
    return Number.isNaN(t) ? 0 : t;
  };
  const byKey = new Map<string, KbFactRecord>();
  for (const f of facts) {
    const key = `${f.metric}.${f.period}`;
    const cur = byKey.get(key);
    if (!cur) { byKey.set(key, f); continue; }
    const better =
      RUNG_RANK[f.rung] < RUNG_RANK[cur.rung] ||
      (RUNG_RANK[f.rung] === RUNG_RANK[cur.rung] && asOfMs(f.asOf) > asOfMs(cur.asOf));
    if (better) byKey.set(key, f);
  }

  const manifestFacts: Record<string, Fact> = {};
  const periods = new Set<string>();
  for (const [key, r] of byKey) {
    periods.add(r.period);
    manifestFacts[key] = {
      id: key,
      metric: r.metric,
      label: r.metric,
      period: r.period,
      kind: r.kind,
      value: r.value,
      unit: r.unit,
      rung: r.rung,
      provenance: r.provenance,
      verification: { status: "SINGLE_SOURCE", checks: [] },
    };
  }

  // A source document entry per contributing source, so the manifest is well-formed. The renderer
  // does not read these, but the manifest contract requires them.
  const sources: Record<string, SourceDocument> = {};
  const tag: ProvenanceTag = "NF";
  for (const s of entity.sources) {
    sources[s] = { sourceId: s, tag, documentName: `${s} (accumulated in the knowledge graph)`, retrievedAt: entity.lastSeen, origin: s };
  }

  const latestPeriodEnd = [...periods].sort().reverse()[0] ?? "";
  const meta: EntityMeta = {
    companyName: entity.names[0] ?? entity.identifiers.name,
    companyNumber: entity.identifiers.chNumber ?? entity.identifiers.cik ?? "",
    jurisdiction: "",
    status: "",
    incorporatedOn: "",
    sicCodes: [],
    registeredOffice: "",
    accountsType: "full",
    latestPeriodEnd,
    synthetic: false,
    lei: entity.identifiers.lei,
  };

  return { entity: meta, facts: manifestFacts, sources, generatedAt: entity.lastSeen };
}
