// lib/kb/graph.ts
// The knowledge store as a typed, in-memory graph over the frozen contracts. This is the
// KB engine's spine: it decomposes a FactManifest (see lib/engine/types) into a small set
// of node kinds and the edges between them, so the query, coverage and checking surfaces
// have one clean structure to read rather than re-walking a manifest each time.
//
// It complements lib/store/tearSheetStore (the persistence seam) rather than replacing it:
// the store durably holds whole manifests keyed by tenant; this graph holds the decomposed,
// query-ready view. Tenancy is a first-class argument, mirroring the store, so the MNPI wall
// has somewhere to stand here too. There is no database; the structure is per-process.

import type { EntityMeta, Fact, FactManifest, ProvenanceTag, SourceDocument } from "../engine/types";

// ---------------------------------------------------------------------------
// Node and edge shapes
// ---------------------------------------------------------------------------
// Four node kinds, exactly as the KB doctrine calls for:
//   ENTITY      a company (from EntityMeta)
//   INSTRUMENT  a debt tranche / registered charge (from a tranche/charge fact)
//   DOCUMENT    a source filing (from manifest.sources)
//   FACT        a single resolved figure (every entry in manifest.facts)

export type KbNodeKind = "ENTITY" | "INSTRUMENT" | "DOCUMENT" | "FACT";

export interface EntityNode {
  kind: "ENTITY";
  id: string; // "ENTITY:<companyNumber>"
  companyNumber: string;
  companyName: string;
  meta: EntityMeta;
}

export interface InstrumentNode {
  kind: "INSTRUMENT";
  id: string; // "INSTRUMENT:<companyNumber>:<metric>"
  metric: string; // the fact metric that carries the instrument (e.g. "trancheTermLoan", "charge1")
  label: string;
  companyNumber: string;
}

export interface DocumentNode {
  kind: "DOCUMENT";
  id: string; // "DOCUMENT:<sourceId>"
  sourceId: string;
  tag: ProvenanceTag;
  documentName: string;
  source: SourceDocument;
}

export interface FactNode {
  kind: "FACT";
  id: string; // "FACT:<companyNumber>:<factId>"
  factId: string; // the manifest key, e.g. "netDebt.FY2024"
  companyNumber: string;
  period: string;
  metric: string;
  fact: Fact;
}

export type KbNode = EntityNode | InstrumentNode | DocumentNode | FactNode;

// Edges are directed and carry a relation label. A fact points at the entity it describes
// (the period it belongs to travels on the edge), at the document it was read from, and at
// the instrument it quantifies where one applies. Instruments and documents point at their
// entity.
export type KbEdgeRel =
  | "FACT_OF_ENTITY"
  | "FACT_FROM_DOCUMENT"
  | "FACT_OF_INSTRUMENT"
  | "INSTRUMENT_OF_ENTITY"
  | "DOCUMENT_OF_ENTITY";

export interface KbEdge {
  rel: KbEdgeRel;
  from: string; // node id
  to: string; // node id
  period?: string; // set on FACT_OF_ENTITY, the reporting period the fact belongs to
}

// ---------------------------------------------------------------------------
// Instrument detection
// ---------------------------------------------------------------------------
// A fact represents an instrument when its metric names a capital tranche or a registered
// charge. This mirrors the fixture capital structures (trancheTermLoan, trancheRcf) and the
// live Companies House charge facts (charge1, charge2, ...).

const TRANCHE_RE = /^tranche/i;
const CHARGE_RE = /^charge\d+$/i;

export function isInstrumentMetric(metric: string): boolean {
  return TRANCHE_RE.test(metric) || CHARGE_RE.test(metric);
}

// ---------------------------------------------------------------------------
// Per-tenant subgraph
// ---------------------------------------------------------------------------

export class TenantGraph {
  readonly tenantId: string;
  readonly nodes = new Map<string, KbNode>();
  readonly edges: KbEdge[] = [];

  constructor(tenantId: string) {
    this.tenantId = tenantId;
  }

  private putNode(node: KbNode): void {
    // Idempotent: re-ingesting the same manifest overwrites in place rather than duplicating.
    this.nodes.set(node.id, node);
  }

  private addEdge(edge: KbEdge): void {
    const exists = this.edges.some(
      (e) => e.rel === edge.rel && e.from === edge.from && e.to === edge.to && e.period === edge.period
    );
    if (!exists) this.edges.push(edge);
  }

  // --- Ingest a whole manifest for one entity ---
  ingest(manifest: FactManifest): void {
    const companyNumber = manifest.entity.companyNumber;
    const entityId = `ENTITY:${companyNumber}`;

    this.putNode({
      kind: "ENTITY",
      id: entityId,
      companyNumber,
      companyName: manifest.entity.companyName,
      meta: manifest.entity,
    });

    // Documents from manifest.sources, each linked to the entity.
    for (const source of Object.values(manifest.sources)) {
      const docId = `DOCUMENT:${source.sourceId}`;
      this.putNode({
        kind: "DOCUMENT",
        id: docId,
        sourceId: source.sourceId,
        tag: source.tag,
        documentName: source.documentName,
        source,
      });
      this.addEdge({ rel: "DOCUMENT_OF_ENTITY", from: docId, to: entityId });
    }

    // Facts, and instruments derived from tranche/charge facts.
    for (const fact of Object.values(manifest.facts)) {
      const factNodeId = `FACT:${companyNumber}:${fact.id}`;
      this.putNode({
        kind: "FACT",
        id: factNodeId,
        factId: fact.id,
        companyNumber,
        period: fact.period,
        metric: fact.metric,
        fact,
      });
      // Fact -> entity, carrying the period.
      this.addEdge({ rel: "FACT_OF_ENTITY", from: factNodeId, to: entityId, period: fact.period });

      // Fact -> document, when it carries provenance to a known source. Derived lines
      // (sourceId "derived") point at no single document, so no edge is drawn.
      const sourceId = fact.provenance?.sourceId;
      if (sourceId && sourceId !== "derived") {
        const docId = `DOCUMENT:${sourceId}`;
        if (!this.nodes.has(docId)) {
          // Provenance referenced a source not present in manifest.sources; record a stub so
          // the edge still resolves rather than dangling.
          this.putNode({
            kind: "DOCUMENT",
            id: docId,
            sourceId,
            tag: fact.provenance!.tag,
            documentName: fact.provenance!.documentName,
            source: {
              sourceId,
              tag: fact.provenance!.tag,
              documentName: fact.provenance!.documentName,
              retrievedAt: fact.provenance!.retrievedAt,
              origin: "provenance (not in manifest.sources)",
            },
          });
          this.addEdge({ rel: "DOCUMENT_OF_ENTITY", from: docId, to: entityId });
        }
        this.addEdge({ rel: "FACT_FROM_DOCUMENT", from: factNodeId, to: docId });
      }

      // Instrument node for tranche/charge facts.
      if (isInstrumentMetric(fact.metric)) {
        const instId = `INSTRUMENT:${companyNumber}:${fact.metric}`;
        if (!this.nodes.has(instId)) {
          this.putNode({
            kind: "INSTRUMENT",
            id: instId,
            metric: fact.metric,
            label: fact.label,
            companyNumber,
          });
          this.addEdge({ rel: "INSTRUMENT_OF_ENTITY", from: instId, to: entityId });
        }
        this.addEdge({ rel: "FACT_OF_INSTRUMENT", from: factNodeId, to: instId });
      }
    }
  }

  // --- Typed readers ---
  entities(): EntityNode[] {
    return [...this.nodes.values()].filter((n): n is EntityNode => n.kind === "ENTITY");
  }

  documents(companyNumber?: string): DocumentNode[] {
    const docs = [...this.nodes.values()].filter((n): n is DocumentNode => n.kind === "DOCUMENT");
    if (!companyNumber) return docs;
    const entityId = `ENTITY:${companyNumber}`;
    const linked = new Set(
      this.edges
        .filter((e) => e.rel === "DOCUMENT_OF_ENTITY" && e.to === entityId)
        .map((e) => e.from)
    );
    return docs.filter((d) => linked.has(d.id));
  }

  instruments(companyNumber?: string): InstrumentNode[] {
    const insts = [...this.nodes.values()].filter((n): n is InstrumentNode => n.kind === "INSTRUMENT");
    return companyNumber ? insts.filter((i) => i.companyNumber === companyNumber) : insts;
  }

  factNodes(companyNumber?: string): FactNode[] {
    const fs = [...this.nodes.values()].filter((n): n is FactNode => n.kind === "FACT");
    return companyNumber ? fs.filter((f) => f.companyNumber === companyNumber) : fs;
  }

  facts(companyNumber?: string): Fact[] {
    return this.factNodes(companyNumber).map((n) => n.fact);
  }
}

// ---------------------------------------------------------------------------
// The tenant-scoped store
// ---------------------------------------------------------------------------

export class KnowledgeGraph {
  private tenants = new Map<string, TenantGraph>();

  // Decompose a manifest into nodes and edges under the given tenant. Returns the tenant
  // subgraph so callers can read it back immediately.
  ingestManifest(tenantId: string, manifest: FactManifest): TenantGraph {
    const graph = this.tenant(tenantId) ?? new TenantGraph(tenantId);
    graph.ingest(manifest);
    this.tenants.set(tenantId, graph);
    return graph;
  }

  tenant(tenantId: string): TenantGraph | undefined {
    return this.tenants.get(tenantId);
  }

  tenantIds(): string[] {
    return [...this.tenants.keys()];
  }
}
