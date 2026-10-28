// lib/graph/path.ts
// Warmest-intro path-finding: the "why you" half of an origination suggestion. Finds the
// most trusted relationship path from the client firm's nodes to a target, hop by hop, each
// hop carrying its own provenance. It ABSTAINS (returns null) when no path clears the
// confidence floor - a cold target is honestly cold, never linked by a guessed connection.
//
// Cost model: warmer = lower cost. Each edge costs a relationship-type prior divided by its
// asserted confidence and strength, so a direct, high-confidence CRM "introduced_by" is far
// cheaper than a low-confidence inferred "portfolio_of". Inference edges are excluded unless
// explicitly opted in. Depth is capped so it stays fast on a tenant-partitioned graph.

import type { GraphStore } from "./store";
import type { WarmPath, IntroHop, EdgeRel, GraphEdge } from "./model";

// Lower = a warmer/more trusted relationship type.
const REL_PRIOR: Record<EdgeRel, number> = {
  introduced_by: 1.0,
  knows: 1.05,
  works_at: 1.2,
  officer_of: 1.25,
  party_to: 1.3,
  advised: 1.5,
  financed: 1.5,
  sponsored: 1.6,
  owns: 1.8,
  parent_of: 1.8,
  portfolio_of: 1.9,
};

export interface WarmestPathOptions {
  maxDepth?: number; // hop cap (default 4)
  confidenceFloor?: number; // drop any path with a hop below this (default 0.3)
  includeInference?: boolean; // include assertionType="inference" edges (default false)
  maxPaths?: number; // top-K paths to return (default 3)
  maxExpansions?: number; // hard cap on node expansions, a DoS guard (default 50,000)
}

function edgeCost(e: GraphEdge): number {
  const prior = REL_PRIOR[e.rel] ?? 2.0;
  const conf = Math.max(e.confidence, 0.05);
  const strength = Math.max(e.strength ?? 0.6, 0.1);
  return prior / (conf * strength);
}

export async function warmestPaths(
  store: GraphStore,
  tenantId: string,
  fromIds: string[],
  targetId: string,
  opts: WarmestPathOptions = {},
): Promise<WarmPath[] | null> {
  const maxDepth = opts.maxDepth ?? 4;
  const floor = opts.confidenceFloor ?? 0.3;
  const includeInference = opts.includeInference ?? false;
  const maxPaths = opts.maxPaths ?? 3;
  const maxExpansions = opts.maxExpansions ?? 50_000;

  const found: WarmPath[] = [];
  // A branching budget: the number of simple paths through a dense hub grows as (degree ^ depth),
  // so depth-capping alone does not bound the work - a single 100-neighbour node at depth 4 is
  // c. 10^8 paths. This caps total node expansions and stops early, returning the warmest paths
  // found within budget rather than hanging the request. Generous enough to never bite a normal
  // tenant graph (small, depth-capped); it is purely a runaway/DoS guard.
  let expansions = 0;
  let budgetExhausted = false;

  // Bounded DFS over simple paths from each start node to the target. Tenant graphs are
  // small and depth-capped, so enumeration is cheap and lets us keep the K warmest.
  const dfs = async (nodeId: string, visited: Set<string>, hops: IntroHop[], cost: number, minConf: number) => {
    if (budgetExhausted) return;
    if (hops.length > maxDepth) return;
    if (nodeId === targetId && hops.length > 0) {
      found.push({ hops: [...hops], totalCost: cost, minConfidence: minConf });
      return;
    }
    if (hops.length === maxDepth) return;
    const nbrs = await store.neighbours(tenantId, nodeId);
    for (const { edge, node } of nbrs) {
      if (visited.has(node.id)) continue;
      if (!includeInference && edge.assertionType === "inference") continue;
      if (edge.confidence < floor) continue;
      if (++expansions > maxExpansions) { budgetExhausted = true; return; }
      visited.add(node.id);
      hops.push({ fromId: nodeId, toId: node.id, rel: edge.rel, provenance: edge.provenance });
      await dfs(node.id, visited, hops, cost + edgeCost(edge), Math.min(minConf, edge.confidence));
      hops.pop();
      visited.delete(node.id);
    }
  };

  for (const start of fromIds) {
    if (budgetExhausted) break;
    await dfs(start, new Set([start]), [], 0, 1);
  }

  if (found.length === 0) return null; // abstain: no warm path
  found.sort((a, b) => a.totalCost - b.totalCost);
  return found.slice(0, maxPaths);
}
