// lib/graph/resolve.ts
// Entity resolution for graph nodes - the highest-leverage correctness step: a wrong link
// silently corrupts every downstream suggestion, so this ABSTAINS rather than mis-links. A
// name-only firm/company node (a lender named on a charge, a corporate PSC) is resolved to a
// canonical LEI via GLEIF only on a confident match; otherwise it stays "unresolved" in a
// review band. Resolution is additive: it upgrades a node's ids/status, never invents a link.

import type { GraphStore } from "./store";
import type { GraphNode } from "./model";
import { resolveLei, type ResolveOptions } from "../sources/gleif";

export interface ResolveNodeOptions extends Pick<ResolveOptions, "country" | "fetchImpl"> {}

// Attempt to resolve a single node. Returns the fields to upgrade (empty if nothing to do or
// no confident match). Only firm/company nodes without a canonical key are resolved.
export async function resolveNode(node: GraphNode, opts: ResolveNodeOptions = {}): Promise<Partial<GraphNode>> {
  if (node.lei || node.chNumber || node.cik) return {};
  if (node.kind !== "firm" && node.kind !== "company") return {};
  const rec = await resolveLei(node.displayName, { country: opts.country ?? "GB", fetchImpl: opts.fetchImpl });
  if (rec) {
    return { lei: rec.lei, resolutionStatus: "resolved", resolutionConfidence: 0.95 };
  }
  return { resolutionStatus: "unresolved" }; // stays in the review band; never force-linked
}

// Resolve every unresolved firm/company node in a tenant's graph, best-effort. Cached GLEIF
// keeps the call volume tiny. Returns counts for the review dashboard.
export async function resolveGraphNodes(
  store: GraphStore,
  tenantId: string,
  opts: ResolveNodeOptions = {},
): Promise<{ resolved: number; abstained: number }> {
  const nodes = await store.allNodes(tenantId);
  let resolved = 0;
  let abstained = 0;
  for (const n of nodes) {
    if (n.lei || n.chNumber || n.cik) continue;
    if (n.kind !== "firm" && n.kind !== "company") continue;
    const upd = await resolveNode(n, opts);
    if (upd.lei) {
      await store.addNode({ ...n, ...upd });
      resolved++;
    } else {
      abstained++;
    }
  }
  return { resolved, abstained };
}

// A non-committal preview of the LEI a name-only node would resolve to, with the evidence a human
// needs to confirm it in the review queue (the canonical name and jurisdiction GLEIF returned).
// Returns null when the node is already keyed, is not a firm/company, or the match abstains: the
// same strict thresholds resolveLei applies, so an ambiguous name yields no proposal.
export interface LeiProposal {
  lei: string;
  confidence: number;
  legalName: string;
  jurisdiction: string;
  status: string;
}

export async function proposeLei(node: GraphNode, opts: ResolveNodeOptions = {}): Promise<LeiProposal | null> {
  if (node.lei || node.chNumber || node.cik) return null;
  if (node.kind !== "firm" && node.kind !== "company") return null;
  const rec = await resolveLei(node.displayName, { country: opts.country ?? "GB", fetchImpl: opts.fetchImpl });
  if (!rec) return null;
  return { lei: rec.lei, confidence: 0.95, legalName: rec.legalName, jurisdiction: rec.jurisdiction, status: rec.status };
}

// The full review pass: resolve every name-only node to its LEI (abstaining on ambiguity, exactly
// as resolveGraphNodes does), then fold together any nodes that now share a canonical LEI. A merge
// is only ever performed on nodes that resolved CONFIDENTLY (resolutionStatus "resolved" with a
// LEI); an ambiguous node never acquired a LEI, so it is never in a sharing group and is left
// untouched in the review band. Returns counts for the review dashboard.
export interface ResolveMergeSummary {
  resolved: number; // name-only nodes upgraded to a LEI this pass
  merged: number; // duplicate nodes folded away
  unresolved: number; // nodes that abstained and stay in the review band
  groups: number; // distinct LEIs that had more than one node
}

export async function resolveAndMergeGraph(
  store: GraphStore,
  tenantId: string,
  opts: ResolveNodeOptions = {},
): Promise<ResolveMergeSummary> {
  const { resolved, abstained } = await resolveGraphNodes(store, tenantId, opts);

  const groups = await store.nodesSharingLei(tenantId);
  let merged = 0;
  let mergedGroups = 0;
  for (const g of groups) {
    // Only confident, resolved nodes are safe to fold; anything else stays for a human.
    const confident = g.nodes.filter((n) => n.resolutionStatus === "resolved" && !!n.lei);
    if (confident.length < 2) continue;
    mergedGroups++;
    // Deterministic survivor: highest resolution confidence, then the lexically smallest id.
    const sorted = [...confident].sort(
      (a, b) => b.resolutionConfidence - a.resolutionConfidence || a.id.localeCompare(b.id),
    );
    const keep = sorted[0];
    for (const drop of sorted.slice(1)) {
      await store.mergeNodes(tenantId, keep.id, drop.id);
      merged++;
    }
  }

  return { resolved, merged, unresolved: abstained, groups: mergedGroups };
}
