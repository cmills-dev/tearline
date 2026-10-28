// lib/kb/kbTypes.ts
// The durable knowledge-graph seams (Module 2, data layer): the master-ID entity spine and the
// cross-source fact accumulation that sits above the per-manifest TenantGraph (lib/kb/graph.ts).
// Where TenantGraph decomposes ONE tear sheet in memory, this layer RESOLVES the same real-world
// company seen through different sources (Companies House number, SEC CIK, GLEIF LEI) to ONE
// master entity, and ACCUMULATES its facts across sources and filings with amendment precedence.
//
// PLANE: this is the shared Tier-0 plane. Public facts (Companies House, EDGAR, ESEF) are shared
// across tenants, so this store is GLOBAL, not tenant-scoped, exactly like the shared-learning
// plane. Entitled and client-supplied facts (which DO live in a tenant silo) carry a tenant id
// and an entitlement tag and are a later addition; the entitlement tag is modelled here now so
// the export-policy layer has something to read from day one.

import type { Fact } from "../engine/types";

// What a source knows about an entity. Only lei / chNumber / cik are join keys; a name alone is
// never a join key (too ambiguous), it is only a last-resort master id and a display label.
export interface EntityIdentifiers {
  chNumber?: string; // Companies House number
  cik?: string; // SEC EDGAR CIK
  lei?: string; // GLEIF Legal Entity Identifier: the strongest cross-source join key
  name: string;
}

export interface MasterEntity {
  masterId: string; // the internal spine id (see chooseMasterId): lei:/ch:/cik:/name:
  identifiers: EntityIdentifiers; // the union of every identifier seen for this entity
  names: string[]; // every name seen, primary first
  sources: string[]; // the source ids that have contributed to this entity
  firstSeen: string; // ISO
  lastSeen: string; // ISO
}

// The plane / licence a fact or document sits on. `public` is Tier-0 shared; `entitled` and
// `client` live only in the owning tenant's silo and the export-policy engine keys on this.
export type EntitlementTag = "public" | "entitled" | "client";

// The Tier-0 knowledge base is a GLOBAL, public-only plane: no tenant scoping and no RLS, by
// design (public facts are shared across every tenant). Only public rows may be written to it. An
// entitled or client-silo row must never land here, or a later per-tenant/entitled source would
// leak licensed data across the MNPI wall via the shared plane. This is the fail-closed guard at
// every Tier-0 write boundary; a silo needs its own tenant-scoped store, not this one.
export function assertPublicTier0(entitlement: EntitlementTag, what: string): void {
  if (entitlement !== "public") {
    throw new Error(`Tier-0 KB is public-only: refusing to write a "${entitlement}" ${what} to the shared plane.`);
  }
}

export interface KbDocumentRecord {
  masterId: string;
  docId: string; // globally addressable: `${source}:${sourceId}`
  source: string; // "companies-house" | "sec-edgar" | "esef" | "fixture" | ...
  documentName: string;
  retrievedAt: string; // when we captured it
  asOf?: string; // the document's effective date (period end / filing date), for staleness
  contentHash?: string;
  entitlement: EntitlementTag;
}

// A fact as ACCUMULATED in the graph (distinct from a manifest Fact: it carries its master
// entity, source, effective date and supersession state). The frozen FactManifest contract is
// untouched; the envelope enrichment lives here.
export interface KbFactRecord {
  masterId: string;
  metric: string;
  period: string;
  value: Fact["value"];
  kind: Fact["kind"];
  unit: string;
  rung: Fact["rung"];
  source: string;
  docId: string;
  asOf: string; // the effective date used for amendment precedence
  entitlement: EntitlementTag;
  provenance: Fact["provenance"];
  superseded: boolean; // true once a newer asOf record replaces it for (masterId, metric, period)
  ingestedAt: string;
}

// Per-entity coverage: for each metric+period we hold a LIVE (non-superseded) fact, which
// sources carry it, its rung and how fresh it is. The honest known-unknowns view builds on this.
export interface KbCoverageItem {
  metric: string;
  period: string;
  rung: Fact["rung"];
  sources: string[];
  asOf: string;
}

export interface KbCoverage {
  masterId: string;
  entityName: string;
  items: KbCoverageItem[];
  sourceCount: number;
}

// ---------------------------------------------------------------------------
// Instruments (#2): a debt tranche or a registered charge attached to an entity.
// ---------------------------------------------------------------------------
// The capital structure compounds on the entity too: an instrument is detected from a
// tranche/charge fact metric (see lib/kb/graph.isInstrumentMetric) and accumulated per source,
// so a charge seen on the Companies House register and a tranche seen in a filing both hang off
// the master entity. An instrument carries no quantum of its own; it points at the fact metric
// that quantifies it.
export interface KbInstrument {
  masterId: string;
  instrumentId: string; // stable within the entity, e.g. the fact metric ("charge1", "trancheRcf")
  kind: "charge" | "tranche";
  label: string;
  metric: string; // the fact metric that quantifies this instrument
  source: string;
  asOf: string;
  entitlement: EntitlementTag;
}

// ---------------------------------------------------------------------------
// Known-unknowns / coverage-gap report (#3): honest supportability per concept.
// ---------------------------------------------------------------------------
// For each concept a desk might want, either we hold a live fact (supported) or we do not, and
// where we do not, WHY, and what would close the gap. The canonical case is UK filleted accounts,
// which carry no profit and loss, so turnover and operating profit are unsupportable from
// Companies House alone and need full accounts or an entitled source.
export interface KnownUnknownItem {
  concept: string; // engine concept key (see lib/clientspec/concepts)
  supported: boolean; // true when a live fact is held
  rung?: Fact["rung"]; // the rung of the held fact, when supported
  sources: string[]; // sources holding it, when supported
  gapReason?: string; // why it is missing, when not supported
  closesWith?: string; // what would close the gap (a source or an entitlement or a client doc)
}

export interface KnownUnknowns {
  masterId: string;
  entityName: string;
  supportedCount: number;
  gapCount: number;
  items: KnownUnknownItem[];
}

// The durable knowledge-graph store. GLOBAL (shared Tier-0 plane), so no tenant argument. A
// PostgresKbStore activates when DATABASE_URL is set, an in-memory default otherwise, exactly
// like the other stores.
export interface KbStore {
  // Find-or-create-or-merge an entity from a set of identifiers; returns its master id. Merges
  // two previously-separate entities when a new source links them by a shared identifier.
  resolveEntity(ids: EntityIdentifiers): Promise<string>;
  getEntity(masterId: string): Promise<MasterEntity | null>;
  listEntities(): Promise<MasterEntity[]>;
  addDocument(doc: KbDocumentRecord): Promise<void>;
  // Upsert a fact with amendment precedence: a record with a newer asOf for the same
  // (masterId, metric, period) supersedes the older one (which is kept, marked superseded, for
  // lineage). An older or equal asOf never overwrites a newer live fact.
  upsertFact(fact: KbFactRecord): Promise<void>;
  listFacts(masterId: string, opts?: { includeSuperseded?: boolean }): Promise<KbFactRecord[]>;
  coverage(masterId: string): Promise<KbCoverage>;
  // Instruments (#2): upsert by (masterId, instrumentId, source); list an entity's instruments.
  upsertInstrument(instrument: KbInstrument): Promise<void>;
  listInstruments(masterId: string): Promise<KbInstrument[]>;
}
