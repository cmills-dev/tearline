// test/merge.test.ts
// LEI-based node merge dedupes counterparties without ever mis-linking. Building a graph where two
// nodes resolve to the same LEI and merging: repoints edges, preserves provenance, keeps the
// higher-confidence duplicate. A merge never crosses tenants. An ambiguous node stays unresolved
// and unmerged (honesty). In-memory, mocked fetch, no key/DB.

import { suite, test, assert, assertEqual } from "./harness";
import { InMemoryGraphStore } from "../lib/graph/store";
import { resolveAndMergeGraph } from "../lib/graph/resolve";
import type { GraphNode, GraphEdge } from "../lib/graph/model";

const T = "tenant-1";
const OTHER = "tenant-2";

const jsonRes = (status: number, body: unknown) =>
  ({ status, ok: status >= 200 && status < 300, json: async () => body } as unknown as Response);
const leiItem = (lei: string, name: string) => ({
  id: lei,
  attributes: {
    entity: { legalName: { name }, legalAddress: { country: "GB" }, registeredAt: { id: "RA000585" } },
    registration: { status: "ISSUED" },
  },
});
const node = (tenantId: string, id: string, name: string, extra: Partial<GraphNode> = {}): GraphNode => ({
  id, tenantId, kind: "firm", firmRole: "lender", displayName: name,
  resolutionConfidence: 0.5, resolutionStatus: "unresolved", ...extra,
});
const edge = (
  id: string, src: string, dst: string, conf: number, source: string,
  rel: GraphEdge["rel"] = "financed", tenantId = T,
): GraphEdge => ({
  id, tenantId, srcId: src, dstId: dst, rel, assertionType: "assertion", confidence: conf,
  visibility: "shared", provenance: { source, evidenceQuote: `${source} evidence`, retrievedAt: "2026-08-01" },
});

suite("graph / entity merge");

export async function registerMergeTests(): Promise<void> {
  // ---- Two spellings of the same lender resolve to one LEI, then merge. ----
  const store = new InMemoryGraphStore();
  await store.addNode(node(T, "co:target", "Target Ltd", { kind: "company", firmRole: undefined, resolutionStatus: "resolved", resolutionConfidence: 1 }));
  await store.addNode(node(T, "firm:hsbc-a", "HSBC UK Bank plc"));
  await store.addNode(node(T, "firm:hsbc-b", "HSBC UK Bank")); // same entity, second source spelling
  // Each spelling was named on a different charge; both point at the target with differing confidence.
  await store.addEdge(edge("e-a", "firm:hsbc-a", "co:target", 0.7, "ch-charges"));
  await store.addEdge(edge("e-b", "firm:hsbc-b", "co:target", 0.9, "rns")); // higher-confidence duplicate
  // A distinct edge (different rel) that must survive the merge untouched.
  await store.addEdge(edge("e-c", "firm:hsbc-b", "co:target", 0.6, "gleif-rr", "advised"));

  const bothResolve = (async () =>
    jsonRes(200, {
      data: [leiItem("2138HSBCUKBANK0000000", "HSBC UK BANK PLC")],
      meta: { pagination: { total: 1 } },
    })) as unknown as typeof fetch;

  const summary = await resolveAndMergeGraph(store, T, { fetchImpl: bothResolve });

  const a = await store.getNode(T, "firm:hsbc-a");
  const b = await store.getNode(T, "firm:hsbc-b");
  const survivorId = a ? "firm:hsbc-a" : "firm:hsbc-b";
  const survivor = a ?? b;
  const targetNbrs = await store.neighbours(T, "co:target");
  const financed = targetNbrs.filter((n) => n.edge.rel === "financed");
  const advised = targetNbrs.filter((n) => n.edge.rel === "advised");

  test("both spellings resolve to the same LEI and one node survives", () => {
    assertEqual(summary.resolved, 2, "two name-only nodes resolved");
    assertEqual(summary.merged, 1, "one duplicate folded away");
    assert(!!survivor && survivor.lei === "2138HSBCUKBANK0000000", "survivor carries the canonical LEI");
    assertEqual(survivor!.resolutionStatus, "resolved", "survivor is resolved");
    assert(!(a && b), "exactly one of the two duplicate nodes remains");
  });

  test("edges repoint onto the survivor, keeping the higher-confidence duplicate with its provenance", () => {
    // The two financed edges shared src/dst/rel after repointing -> the 0.9 rns edge wins.
    assertEqual(financed.length, 1, "duplicate financed edges collapsed to one");
    assertEqual(financed[0].edge.confidence, 0.9, "higher-confidence edge kept");
    assertEqual(financed[0].edge.provenance.source, "rns", "its provenance is preserved");
    assertEqual(financed[0].edge.srcId, survivorId, "edge now points from the survivor");
    // A non-duplicate edge (different rel) is repointed but not collapsed.
    assertEqual(advised.length, 1, "the distinct advised edge survives the merge");
    assertEqual(advised[0].edge.srcId, survivorId, "advised edge also repointed onto the survivor");
    assertEqual(advised[0].edge.provenance.source, "gleif-rr", "its provenance is intact");
  });

  // ---- A merge never crosses tenants. ----
  const cross = new InMemoryGraphStore();
  await cross.addNode(node(T, "firm:x", "Acme Ltd", { lei: "LEI-ACME", resolutionStatus: "resolved" }));
  await cross.addNode(node(OTHER, "firm:x", "Acme Ltd", { lei: "LEI-ACME", resolutionStatus: "resolved" }));
  let crossed = false;
  try {
    // dropId lives in OTHER, not T: it must not be found under T, so the merge refuses.
    await cross.mergeNodes(T, "firm:x", "firm:does-not-exist-in-T");
  } catch {
    crossed = true;
  }
  const otherStill = await cross.getNode(OTHER, "firm:x");
  // The same LEI held in two different tenants must NOT read as a shared group in either tenant.
  const sharedInT = await cross.nodesSharingLei(T);

  test("a merge never reaches across tenants", () => {
    assert(crossed, "merging a missing id in-tenant is refused, not silently cross-tenant");
    assert(!!otherStill, "the other tenant's node is untouched");
    assertEqual(sharedInT.length, 0, "a LEI shared only across tenants is not a merge candidate");
  });

  // ---- An ambiguous node stays unresolved and unmerged. ----
  const amb = new InMemoryGraphStore();
  await amb.addNode(node(T, "firm:vague", "Some Nominee Ltd"));
  await amb.addNode(node(T, "firm:anchor", "Anchor Ltd", { lei: "LEI-ANCHOR", resolutionStatus: "resolved" }));
  const ambiguousFetch = (async () =>
    jsonRes(200, {
      data: [leiItem("A", "SOME NOMINEE LIMITED"), leiItem("B", "SOME NOMINEE LIMITED")],
      meta: { pagination: { total: 2 } },
    })) as unknown as typeof fetch;
  const ambSummary = await resolveAndMergeGraph(amb, T, { fetchImpl: ambiguousFetch });
  const vague = await amb.getNode(T, "firm:vague");

  test("an ambiguous node is left unresolved and unmerged (never guessed into a merge)", () => {
    assert(!!vague && !vague.lei, "no LEI attached to the ambiguous node");
    assertEqual(vague!.resolutionStatus, "unresolved", "stays in the review band");
    assertEqual(ambSummary.merged, 0, "nothing merged on an ambiguous match");
    assert(ambSummary.unresolved >= 1, "the abstention is counted for review");
  });

  // ---- Merging two nodes must never disturb an UNRELATED parallel edge elsewhere. ----
  // Regression for the tenant-global dedup bug: two co-lenders (A and B) both finance a target
  // via two distinct sources; merging two entirely unrelated nodes (C, D) must leave the A/B
  // edges - and their distinct provenance - completely intact.
  const iso = new InMemoryGraphStore();
  await iso.addNode(node(T, "firm:a", "Lender A"));
  await iso.addNode(node(T, "firm:b", "Lender B"));
  await iso.addNode(node(T, "co:target", "Target Ltd", { kind: "company", firmRole: undefined }));
  await iso.addNode(node(T, "firm:c", "Unrelated C"));
  await iso.addNode(node(T, "firm:d", "Unrelated D"));
  // Two parallel financed edges from different lenders, different provenance, untouched by the merge.
  await iso.addEdge(edge("p-a", "firm:a", "co:target", 0.8, "ch-charges"));
  await iso.addEdge(edge("p-b", "firm:b", "co:target", 0.6, "client-crm"));
  await iso.mergeNodes(T, "firm:c", "firm:d"); // wholly unrelated to the A/B/target edges
  const targetAfter = await iso.neighbours(T, "co:target");

  test("merging unrelated nodes leaves a parallel edge elsewhere untouched", () => {
    assertEqual(targetAfter.length, 2, "both parallel financed edges survive the unrelated merge");
    const sources = targetAfter.map((n) => n.edge.provenance.source).sort();
    assertEqual(sources.join(","), "ch-charges,client-crm", "both distinct provenances are preserved");
  });
}
