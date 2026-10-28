// lib/graph/store.ts
// The GraphStore seam, mirroring TearSheetStore: tenant-scoped, one interface, an in-memory
// default now and a Postgres implementation later (behind the same interface, activated by
// DATABASE_URL). Every write is rejected if it violates the persistability invariant, so a
// provenance-less (fabricated) relationship can never enter the graph.

import type { GraphNode, GraphEdge } from "./model";
import { isPersistableEdge } from "./model";
import { databaseUrl } from "../store/postgres";
import { PostgresGraphStore } from "./postgres";

export interface Neighbour {
  edge: GraphEdge;
  node: GraphNode;
}

// A set of nodes in one tenant that carry the same canonical LEI: the merge-candidate unit the
// review UI lists. Two nodes sharing a confidently resolved LEI are the same legal entity seen
// through two sources, so they are safe to fold into one.
export interface LeiGroup {
  lei: string;
  nodes: GraphNode[];
}

export interface GraphStore {
  addNode(n: GraphNode): Promise<void>;
  addEdge(e: GraphEdge): Promise<void>;
  getNode(tenantId: string, id: string): Promise<GraphNode | null>;
  findNodesByName(tenantId: string, name: string): Promise<GraphNode[]>;
  neighbours(tenantId: string, nodeId: string): Promise<Neighbour[]>;
  allNodes(tenantId: string): Promise<GraphNode[]>;
  // Fold dropId into keepId within one tenant: repoint every edge, drop duplicates keeping the
  // higher confidence, carry the surviving node's canonical fields (preferring a resolved LEI),
  // then delete dropId. Never crosses tenants.
  mergeNodes(tenantId: string, keepId: string, dropId: string): Promise<void>;
  // Groups of two-or-more nodes sharing a canonical LEI: the merge candidates for review.
  nodesSharingLei(tenantId: string): Promise<LeiGroup[]>;
}

// Pure field-merge rule for a node merge, shared by both stores. The surviving node keeps its own
// identity (id/displayName) and canonical fields, but inherits a canonical key the drop node holds
// and it lacks - so a resolved LEI is never lost to a merge. Status becomes "resolved" whenever
// either side carries a LEI, and the confidence is the better of the two.
export function pickSurvivingNode(keep: GraphNode, drop: GraphNode): GraphNode {
  const lei = keep.lei ?? drop.lei;
  return {
    ...keep,
    lei,
    chNumber: keep.chNumber ?? drop.chNumber,
    cik: keep.cik ?? drop.cik,
    ocId: keep.ocId ?? drop.ocId,
    resolutionStatus: lei ? "resolved" : keep.resolutionStatus,
    resolutionConfidence: Math.max(keep.resolutionConfidence, drop.resolutionConfidence),
  };
}

export class InMemoryGraphStore implements GraphStore {
  private nodes = new Map<string, GraphNode>(); // key = tenantId::id
  private edges: GraphEdge[] = [];

  private nk(tenantId: string, id: string) {
    return `${tenantId}::${id}`;
  }

  async addNode(n: GraphNode): Promise<void> {
    this.nodes.set(this.nk(n.tenantId, n.id), n);
  }

  async addEdge(e: GraphEdge): Promise<void> {
    if (!isPersistableEdge(e)) {
      throw new Error(`Refusing to add a relationship without provenance: ${e.srcId}->${e.dstId} (${e.rel})`);
    }
    // Dedup by (tenantId, id) so a re-ingest UPSERTS rather than appending a duplicate parallel
    // edge - matching the Postgres store's `on conflict (tenant_id, id) do update`. Without this,
    // an in-memory graph seeded twice would double every edge, inflating corroboration counts and
    // biasing path-finding toward re-ingested relationships.
    const idx = this.edges.findIndex((x) => x.tenantId === e.tenantId && x.id === e.id);
    if (idx >= 0) this.edges[idx] = e;
    else this.edges.push(e);
  }

  async getNode(tenantId: string, id: string): Promise<GraphNode | null> {
    return this.nodes.get(this.nk(tenantId, id)) ?? null;
  }

  async findNodesByName(tenantId: string, name: string): Promise<GraphNode[]> {
    const q = name.trim().toLowerCase();
    return [...this.nodes.values()].filter(
      (n) => n.tenantId === tenantId && n.displayName.toLowerCase().includes(q),
    );
  }

  // Undirected adjacency: a relationship is traversable either way for intro-pathing.
  async neighbours(tenantId: string, nodeId: string): Promise<Neighbour[]> {
    const out: Neighbour[] = [];
    for (const e of this.edges) {
      if (e.tenantId !== tenantId) continue;
      let otherId: string | null = null;
      if (e.srcId === nodeId) otherId = e.dstId;
      else if (e.dstId === nodeId) otherId = e.srcId;
      if (!otherId) continue;
      const node = this.nodes.get(this.nk(tenantId, otherId));
      if (node) out.push({ edge: e, node });
    }
    return out;
  }

  async allNodes(tenantId: string): Promise<GraphNode[]> {
    return [...this.nodes.values()].filter((n) => n.tenantId === tenantId);
  }

  async mergeNodes(tenantId: string, keepId: string, dropId: string): Promise<void> {
    if (keepId === dropId) return;
    // Both nodes are looked up under the same tenant, so a cross-tenant id simply is not found:
    // a merge can never span the MNPI wall.
    const keep = this.nodes.get(this.nk(tenantId, keepId));
    const drop = this.nodes.get(this.nk(tenantId, dropId));
    if (!keep || !drop) {
      throw new Error(`mergeNodes: both keepId and dropId must exist in tenant ${tenantId}`);
    }

    // Repoint every edge referencing dropId onto keepId, preserving each edge's provenance and
    // confidence (we only rewrite the endpoint ids).
    for (const e of this.edges) {
      if (e.tenantId !== tenantId) continue;
      if (e.srcId === dropId) e.srcId = keepId;
      if (e.dstId === dropId) e.dstId = keepId;
    }

    // Collapse ONLY edges now incident to keepId (the ones the repoint could have duplicated);
    // everything else passes through, so merging two nodes never drops a parallel edge elsewhere
    // in the graph. Two edges that now share src/dst/rel are the same relationship corroborated
    // (or duplicated) and fold to the higher-confidence one; its provenance is what survives.
    // Self-loops the merge created are dropped; ties break on the smaller edge id, so the result
    // matches the Postgres store and is reproducible.
    const survivors: GraphEdge[] = [];
    const bestByKey = new Map<string, GraphEdge>();
    for (const e of this.edges) {
      const incident = e.tenantId === tenantId && (e.srcId === keepId || e.dstId === keepId);
      if (e.tenantId === tenantId && e.srcId === e.dstId) continue; // self-loop from the merge
      if (!incident) {
        survivors.push(e);
        continue;
      }
      const key = `${e.srcId}\u0000${e.dstId}\u0000${e.rel}`;
      const existing = bestByKey.get(key);
      if (!existing || e.confidence > existing.confidence || (e.confidence === existing.confidence && e.id < existing.id)) bestByKey.set(key, e);
    }
    this.edges = survivors.concat([...bestByKey.values()]);

    this.nodes.set(this.nk(tenantId, keepId), pickSurvivingNode(keep, drop));
    this.nodes.delete(this.nk(tenantId, dropId));
  }

  async nodesSharingLei(tenantId: string): Promise<LeiGroup[]> {
    const byLei = new Map<string, GraphNode[]>();
    for (const n of this.nodes.values()) {
      if (n.tenantId !== tenantId || !n.lei) continue;
      const arr = byLei.get(n.lei) ?? [];
      arr.push(n);
      byLei.set(n.lei, arr);
    }
    return [...byLei.entries()]
      .filter(([, ns]) => ns.length > 1)
      .map(([lei, nodes]) => ({ lei, nodes }));
  }
}

// Hung off globalThis, not a module-level `let`: in Next.js dev each route is bundled separately,
// so a module-level singleton would differ per bundle and a graph seeded through /api/onboarding/
// network would be invisible to /api/originate. globalThis is shared across every bundle in the one
// process. (With DATABASE_URL set the store is external, so this is moot.)
const g = globalThis as unknown as { __graphStore__?: GraphStore | null };
export function getGraphStore(): GraphStore {
  if (g.__graphStore__) return g.__graphStore__;
  // Durable Postgres graph when a database is configured, else in-memory (self-contained
  // demo). The Postgres adapter loads its client via a guarded dynamic import, so the
  // in-memory default pulls in nothing.
  g.__graphStore__ = databaseUrl() ? new PostgresGraphStore() : new InMemoryGraphStore();
  return g.__graphStore__;
}
export function resetGraphStoreForTests(): void {
  g.__graphStore__ = null;
}
