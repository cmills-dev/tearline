// lib/kb/ingest.ts
// The ingest pipeline that feeds a per-manifest tear sheet into the durable knowledge graph
// (Module 2). It does two things and nothing else: it RESOLVES the manifest's entity onto the
// master-ID spine (so the same real-world company seen through Companies House, SEC EDGAR and
// ESEF lands on ONE master entity), and it ACCUMULATES that manifest's documents and facts onto
// that entity across sources and filings with amendment precedence.
//
// This is pure orchestration. It never computes, invents or mutates a fact's VALUE; it only wraps
// each already-resolved Fact in an accumulation envelope (master id, source, effective date) and
// hands it to the store, which owns supersession. The frozen FactManifest contract is untouched.

import type { EntityIdentifiers, KbDocumentRecord, KbFactRecord, KbInstrument, KbStore } from "./kbTypes";
import type { Fact, FactManifest } from "../engine/types";
import { isInstrumentMetric } from "./graph";

// The Tier-0 public sources permitted to write to this shared, global plane. Entitled and
// client-supplied sources are silo data and must NOT reach the shared store through this path, so
// an unrecognised source is rejected rather than being silently tagged public. Extend this as new
// public source specialists land (Gazette, GLEIF, LSE, ...).
const PUBLIC_SOURCES = new Set(["companies-house", "sec-edgar", "esef", "fixture"]);

// -- effective-date derivation ----------------------------------------------
// Deterministic, no clock reads. A fact's effective ("as of") date drives amendment precedence in
// the store, so two records for the same (masterId, metric, period, source) order by it. Precedence
// must follow the FILING / as-reported date, NOT the period end (two filings of the same period
// share a period end) and NOT the capture time (a re-fetch of the ORIGINAL filing would otherwise
// supersede a genuine restatement fetched earlier). We therefore prefer `entity.asReportedAt` - the
// real filing date, threaded from a connector that exposes it (SEC's per-fact `filed`) - and only
// fall back to the manifest capture time `generatedAt` for a connector that does not yet supply a
// filing date. Both helpers are exported so the store's tests and callers reason about one rule.
// (A per-fact filing date would be strictly better for a manifest bundling a current filing with a
// prior-year amendment; the manifest-level date is correct for the dominant same-period case.)

export function asOfForFact(_fact: Fact, manifest: FactManifest): string {
  return manifest.entity.asReportedAt || manifest.generatedAt || manifest.entity.latestPeriodEnd;
}

export function asOfForManifest(manifest: FactManifest): string {
  return manifest.entity.asReportedAt || manifest.entity.latestPeriodEnd || manifest.generatedAt;
}

// -- identifier assembly ----------------------------------------------------
// Build the join keys from the manifest, then let an explicit override win field by field. The
// single company number is read as a CIK for an EDGAR manifest and a Companies House number
// otherwise; the LEI, when the manifest carries one, is the strongest cross-source join key.

function identifiersFor(
  manifest: FactManifest,
  source: string,
  idsOverride?: Partial<EntityIdentifiers>
): EntityIdentifiers {
  const ids: EntityIdentifiers = { name: manifest.entity.companyName };

  if (manifest.entity.lei) ids.lei = manifest.entity.lei;

  if (source === "sec-edgar") ids.cik = manifest.entity.companyNumber;
  else ids.chNumber = manifest.entity.companyNumber;

  if (idsOverride) {
    if (idsOverride.name !== undefined) ids.name = idsOverride.name;
    if (idsOverride.lei !== undefined) ids.lei = idsOverride.lei;
    if (idsOverride.chNumber !== undefined) ids.chNumber = idsOverride.chNumber;
    if (idsOverride.cik !== undefined) ids.cik = idsOverride.cik;
  }

  return ids;
}

// -- ingest -----------------------------------------------------------------

export async function ingestManifest(
  store: KbStore,
  manifest: FactManifest,
  source: string,
  idsOverride?: Partial<EntityIdentifiers>
): Promise<{ masterId: string; entityName: string; factsIngested: number; documentsIngested: number }> {
  // Fence the shared plane: only a known Tier-0 public source may write here, so nothing entitled
  // or client-supplied is ever tagged public and leaked into the global store.
  if (!PUBLIC_SOURCES.has(source)) {
    throw new Error(`ingestManifest: "${source}" is not a permitted public Tier-0 source.`);
  }

  // 1) Resolve the entity onto the master-ID spine. A shared identifier merges it with an entity
  //    already seen through another source.
  const ids = identifiersFor(manifest, source, idsOverride);
  const masterId = await store.resolveEntity(ids);

  const manifestAsOf = asOfForManifest(manifest);

  // 2) Accumulate every source document under a globally addressable id.
  let documentsIngested = 0;
  for (const src of Object.values(manifest.sources)) {
    const doc: KbDocumentRecord = {
      masterId,
      docId: `${source}:${src.sourceId}`,
      source,
      documentName: src.documentName,
      retrievedAt: src.retrievedAt,
      asOf: manifestAsOf,
      contentHash: undefined,
      entitlement: "public",
    };
    await store.addDocument(doc);
    documentsIngested++;
  }

  // 3) Accumulate every resolved fact. R4 abstains (value === null) carry no number, so there is
  //    nothing to accumulate; everything else is wrapped and handed to the store, which decides
  //    supersession by asOf. We never touch the value.
  let factsIngested = 0;
  for (const fact of Object.values(manifest.facts)) {
    if (fact.value === null) continue;
    const record: KbFactRecord = {
      masterId,
      metric: fact.metric,
      period: fact.period,
      value: fact.value,
      kind: fact.kind,
      unit: fact.unit,
      rung: fact.rung,
      source,
      docId: `${source}:${fact.provenance?.sourceId ?? "unknown"}`,
      asOf: asOfForFact(fact, manifest),
      entitlement: "public",
      provenance: fact.provenance,
      superseded: false,
      ingestedAt: new Date().toISOString(),
    };
    await store.upsertFact(record);
    factsIngested++;

    // 3b) Capital structure compounds on the entity too. A tranche/charge fact metric names an
    //     instrument (a debt tranche or a registered charge); accumulate it per source, exactly
    //     like a fact, so the same instrument seen through two sources corroborates. Fact value
    //     accumulation above is untouched; the instrument merely points at the metric.
    if (isInstrumentMetric(fact.metric)) {
      const instrument: KbInstrument = {
        masterId,
        instrumentId: fact.metric,
        kind: /^charge/i.test(fact.metric) ? "charge" : "tranche",
        label: fact.label,
        metric: fact.metric,
        source,
        asOf: asOfForFact(fact, manifest),
        entitlement: "public",
      };
      await store.upsertInstrument(instrument);
    }
  }

  return { masterId, entityName: ids.name, factsIngested, documentsIngested };
}
