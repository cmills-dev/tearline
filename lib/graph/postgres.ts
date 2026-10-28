// lib/graph/postgres.ts
// The durable GraphStore, mirroring lib/store/postgres.ts: the `postgres` client is a
// GUARDED DYNAMIC IMPORT so the build passes without it installed. Activated by DATABASE_URL
// (see getGraphStore). warmestPaths (lib/graph/path.ts) runs over neighbours() unchanged, so
// path-finding works against this store today; the recursive-CTE optimisation is a later
// in-place upgrade. The flip step is: npm install postgres; apply db/migrations/0004_graph.sql;
// set DATABASE_URL.

import type { GraphStore, Neighbour, LeiGroup } from "./store";
import { pickSurvivingNode } from "./store";
import type { GraphNode, GraphEdge } from "./model";
import { isPersistableEdge } from "./model";
import { databaseUrl } from "../store/postgres";

interface Sql {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<Record<string, unknown>[]>;
  json(value: unknown): unknown;
  begin<T>(fn: (sql: Sql) => Promise<T>): Promise<T>;
}

let sqlSingleton: Sql | null = null;
async function getSql(): Promise<Sql> {
  if (sqlSingleton) return sqlSingleton;
  const url = databaseUrl();
  if (!url) throw new Error("PostgresGraphStore requires DATABASE_URL");
  const mod = await import(/* webpackIgnore: true */ "postgres");
  const postgres = (mod.default ?? mod) as unknown as (url: string, opts?: unknown) => Sql;
  sqlSingleton = postgres(url, { max: 3, idle_timeout: 20, prepare: false });
  return sqlSingleton;
}

// Run fn inside a transaction that first pins the tenant GUC, so row-level security
// (db/migrations/0004_graph.sql) is enforced by the database on every statement, not only by the
// WHERE clauses. `true` => SET LOCAL (transaction-scoped, pooler-safe).
async function withRls<T>(tenantId: string, fn: (tx: Sql) => Promise<T>): Promise<T> {
  const sql = await getSql();
  return sql.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  });
}

function rowToNode(r: Record<string, unknown>): GraphNode {
  return {
    id: r.id as string, tenantId: r.tenant_id as string, kind: r.kind as GraphNode["kind"],
    firmRole: (r.firm_role as GraphNode["firmRole"]) ?? undefined, displayName: r.display_name as string,
    lei: (r.lei as string) ?? undefined, chNumber: (r.ch_number as string) ?? undefined,
    cik: (r.cik as string) ?? undefined, ocId: (r.oc_id as string) ?? undefined,
    resolutionConfidence: Number(r.resolution_confidence), resolutionStatus: r.resolution_status as GraphNode["resolutionStatus"],
  };
}
function rowToEdge(r: Record<string, unknown>): GraphEdge {
  return {
    id: r.id as string, tenantId: r.tenant_id as string, srcId: r.src_id as string, dstId: r.dst_id as string,
    rel: r.rel as GraphEdge["rel"], assertionType: r.assertion_type as GraphEdge["assertionType"],
    confidence: Number(r.confidence), strength: r.strength == null ? undefined : Number(r.strength),
    validFrom: (r.valid_from as string) ?? undefined, validTo: (r.valid_to as string) ?? undefined,
    visibility: r.visibility as GraphEdge["visibility"], provenance: r.provenance as GraphEdge["provenance"],
  };
}

export class PostgresGraphStore implements GraphStore {
  async addNode(n: GraphNode): Promise<void> {
    await withRls(n.tenantId, (sql) => sql`
      insert into graph_node (tenant_id, id, kind, firm_role, display_name, lei, ch_number, cik, oc_id, resolution_confidence, resolution_status)
      values (${n.tenantId}, ${n.id}, ${n.kind}, ${n.firmRole ?? null}, ${n.displayName}, ${n.lei ?? null}, ${n.chNumber ?? null}, ${n.cik ?? null}, ${n.ocId ?? null}, ${n.resolutionConfidence}, ${n.resolutionStatus})
      on conflict (tenant_id, id) do update set
        display_name = excluded.display_name, firm_role = excluded.firm_role,
        lei = excluded.lei, ch_number = excluded.ch_number, cik = excluded.cik, oc_id = excluded.oc_id,
        resolution_confidence = excluded.resolution_confidence, resolution_status = excluded.resolution_status`);
  }

  async addEdge(e: GraphEdge): Promise<void> {
    if (!isPersistableEdge(e)) throw new Error(`Refusing to add a relationship without provenance: ${e.srcId}->${e.dstId}`);
    await withRls(e.tenantId, (sql) => sql`
      insert into graph_edge (tenant_id, id, src_id, dst_id, rel, assertion_type, confidence, strength, valid_from, valid_to, visibility, provenance)
      values (${e.tenantId}, ${e.id}, ${e.srcId}, ${e.dstId}, ${e.rel}, ${e.assertionType}, ${e.confidence}, ${e.strength ?? null}, ${e.validFrom ?? null}, ${e.validTo ?? null}, ${e.visibility}, ${sql.json(e.provenance)})
      on conflict (tenant_id, id) do update set confidence = excluded.confidence, provenance = excluded.provenance`);
  }

  async getNode(tenantId: string, id: string): Promise<GraphNode | null> {
    const rows = await withRls(tenantId, (sql) => sql`select * from graph_node where tenant_id = ${tenantId} and id = ${id} limit 1`);
    return rows[0] ? rowToNode(rows[0]) : null;
  }

  async findNodesByName(tenantId: string, name: string): Promise<GraphNode[]> {
    const rows = await withRls(tenantId, (sql) => sql`select * from graph_node where tenant_id = ${tenantId} and display_name ilike ${"%" + name + "%"} limit 50`);
    return rows.map(rowToNode);
  }

  async neighbours(tenantId: string, nodeId: string): Promise<Neighbour[]> {
    // One transaction for the whole traversal: the edges and every node lookup run under the same
    // tenant GUC, so RLS is enforced throughout and the reads are consistent.
    return withRls(tenantId, async (sql) => {
      const edges = await sql`select * from graph_edge where tenant_id = ${tenantId} and (src_id = ${nodeId} or dst_id = ${nodeId})`;
      const out: Neighbour[] = [];
      for (const er of edges) {
        const e = rowToEdge(er);
        const otherId = e.srcId === nodeId ? e.dstId : e.srcId;
        const nrows = await sql`select * from graph_node where tenant_id = ${tenantId} and id = ${otherId} limit 1`;
        if (nrows[0]) out.push({ edge: e, node: rowToNode(nrows[0]) });
      }
      return out;
    });
  }

  async allNodes(tenantId: string): Promise<GraphNode[]> {
    const rows = await withRls(tenantId, (sql) => sql`select * from graph_node where tenant_id = ${tenantId} limit 5000`);
    return rows.map(rowToNode);
  }

  async mergeNodes(tenantId: string, keepId: string, dropId: string): Promise<void> {
    if (keepId === dropId) return;
    // The whole merge runs in ONE transaction under the tenant GUC: it is atomic, and RLS fences
    // every statement to this tenant, so a merge can never span the tenancy wall.
    await withRls(tenantId, async (sql) => {
      const keepRows = await sql`select * from graph_node where tenant_id = ${tenantId} and id = ${keepId} limit 1`;
      const dropRows = await sql`select * from graph_node where tenant_id = ${tenantId} and id = ${dropId} limit 1`;
      if (!keepRows[0] || !dropRows[0]) {
        throw new Error(`mergeNodes: both keepId and dropId must exist in tenant ${tenantId}`);
      }
      const survivor = pickSurvivingNode(rowToNode(keepRows[0]), rowToNode(dropRows[0]));

      // Repoint edges onto keepId (provenance/confidence untouched: only the endpoint id changes).
      await sql`update graph_edge set src_id = ${keepId} where tenant_id = ${tenantId} and src_id = ${dropId}`;
      await sql`update graph_edge set dst_id = ${keepId} where tenant_id = ${tenantId} and dst_id = ${dropId}`;
      // Drop self-loops the merge created (only keepId can now have one).
      await sql`delete from graph_edge where tenant_id = ${tenantId} and src_id = dst_id and src_id = ${keepId}`;
      // Dedupe ONLY edges now incident to keepId (the ones the repoint could have duplicated), so a
      // parallel edge elsewhere in the graph is never dropped. Two edges that now share src/dst/rel
      // are the same relationship: keep the higher-confidence row, ties broken by the larger id
      // (matching the in-memory store's keep-smaller-id rule).
      await sql`
        delete from graph_edge e using graph_edge d
        where e.tenant_id = ${tenantId} and d.tenant_id = ${tenantId}
          and (e.src_id = ${keepId} or e.dst_id = ${keepId})
          and e.src_id = d.src_id and e.dst_id = d.dst_id and e.rel = d.rel
          and (e.confidence < d.confidence or (e.confidence = d.confidence and e.id > d.id))`;
      // Carry the surviving node's canonical fields (a resolved LEI is preferred, never lost).
      await sql`
        update graph_node set
          lei = ${survivor.lei ?? null}, ch_number = ${survivor.chNumber ?? null},
          cik = ${survivor.cik ?? null}, oc_id = ${survivor.ocId ?? null},
          resolution_status = ${survivor.resolutionStatus}, resolution_confidence = ${survivor.resolutionConfidence}
        where tenant_id = ${tenantId} and id = ${keepId}`;
      await sql`delete from graph_node where tenant_id = ${tenantId} and id = ${dropId}`;
    });
  }

  async nodesSharingLei(tenantId: string): Promise<LeiGroup[]> {
    const rows = await withRls(tenantId, (sql) => sql`
      select * from graph_node
      where tenant_id = ${tenantId} and lei is not null
        and lei in (
          select lei from graph_node
          where tenant_id = ${tenantId} and lei is not null
          group by lei having count(*) > 1
        )
      order by lei`);
    const byLei = new Map<string, GraphNode[]>();
    for (const r of rows) {
      const n = rowToNode(r);
      const arr = byLei.get(n.lei as string) ?? [];
      arr.push(n);
      byLei.set(n.lei as string, arr);
    }
    return [...byLei.entries()].map(([lei, nodes]) => ({ lei, nodes }));
  }
}
