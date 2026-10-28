// test/graph.test.ts
// The relationship graph: warmest-intro path-finding abstains on a cold target, and a
// relationship without provenance can never enter the graph. In-memory, no key/DB.

import { suite, test, assert, assertEqual } from "./harness";
import { InMemoryGraphStore } from "../lib/graph/store";
import { warmestPaths } from "../lib/graph/path";
import { ingestCharges } from "../lib/graph/ingest/chCharges";
import { ingestOfficers } from "../lib/graph/ingest/chOfficers";
import { ingestPsc } from "../lib/graph/ingest/chPsc";
import type { GraphNode, GraphEdge } from "../lib/graph/model";
import type { ChargesList } from "../lib/sources/companiesHouse";

const T = "tenant-1";
const node = (id: string, kind: GraphNode["kind"], name: string): GraphNode => ({
  id, tenantId: T, kind, displayName: name, resolutionConfidence: 1, resolutionStatus: "resolved",
});
const edge = (id: string, src: string, dst: string, rel: GraphEdge["rel"], conf: number, extra: Partial<GraphEdge> = {}): GraphEdge => ({
  id, tenantId: T, srcId: src, dstId: dst, rel, assertionType: "assertion", confidence: conf,
  visibility: "shared", provenance: { source: "test", retrievedAt: "2026-08-01" }, ...extra,
});

suite("graph / warmest path");

export async function registerGraphTests(): Promise<void> {
  const store = new InMemoryGraphStore();
  await store.addNode(node("myfirm", "firm", "Our Firm"));
  await store.addNode(node("alice", "person", "Alice"));
  await store.addNode(node("lawco", "firm", "Lawco LLP"));
  await store.addNode(node("acme", "company", "Acme Ltd")); // connected target
  await store.addNode(node("globex", "company", "Globex Ltd")); // cold target
  await store.addEdge(edge("e1", "myfirm", "alice", "knows", 0.9, { visibility: "tenant_private", strength: 0.9 }));
  await store.addEdge(edge("e2", "alice", "lawco", "works_at", 0.95));
  await store.addEdge(edge("e3", "lawco", "acme", "advised", 0.8, { provenance: { source: "rns", evidenceQuote: "Lawco advised Acme on its refinancing", retrievedAt: "2026-01-01" } }));
  // an inference-only bridge to globex (excluded by default)
  await store.addEdge(edge("e4", "lawco", "globex", "portfolio_of", 0.5, { assertionType: "inference" }));

  const toAcme = await warmestPaths(store, T, ["myfirm"], "acme");
  const toGlobex = await warmestPaths(store, T, ["myfirm"], "globex");

  let rejected = false;
  try {
    await store.addEdge({ ...edge("bad", "myfirm", "acme", "knows", 0.9), provenance: { source: "", retrievedAt: "" } });
  } catch {
    rejected = true;
  }

  suite("graph / warmest path");

  test("finds the warmest intro path to a connected target, hop by hop", () => {
    assert(!!toAcme && toAcme.length >= 1, "a path exists");
    const p = toAcme![0];
    assertEqual(p.hops.length, 3, "myfirm -> alice -> lawco -> acme");
    assertEqual(p.hops[p.hops.length - 1].toId, "acme", "ends at the target");
    assert(p.minConfidence >= 0.8, "min hop confidence carried");
    assert(p.hops.every((h) => !!h.provenance.source), "every hop carries provenance");
  });

  test("abstains (null) when the only bridge is an inference edge / no warm path", () => {
    assertEqual(toGlobex, null, "cold target -> null (never a guessed link)");
  });

  test("a relationship without provenance is refused", () => {
    assert(rejected, "provenance-less edge rejected");
  });

  // --- CH charges -> financed edges (real public-filing relationships) ---
  const store2 = new InMemoryGraphStore();
  const charges: ChargesList = {
    total_count: 2,
    items: [
      { charge_number: 1, status: "outstanding", created_on: "2022-03-01", persons_entitled: [{ name: "HSBC UK Bank plc" }], secured_details: { description: "Fixed and floating charge" }, classification: { description: "A charge" } },
      { charge_number: 2, status: "satisfied", created_on: "2019-06-01", persons_entitled: [{ name: "Lloyds Bank plc" }], classification: { description: "A charge" } },
    ],
  };
  const ing = await ingestCharges(T, { chNumber: "00502851", name: "Greggs plc" }, charges, store2);
  const lenderNbrs = await store2.neighbours(T, "co:00502851");

  suite("graph / CH charges ingester");

  test("each registered charge seeds a financed edge from the lender, with charge provenance", () => {
    assertEqual(ing.seeded, 2, "two charges -> two financed edges");
    assert(ing.lenders.includes("HSBC UK Bank plc"), "HSBC lender captured");
    const hsbc = lenderNbrs.find((n) => n.node.displayName.includes("HSBC"));
    assert(!!hsbc && hsbc.edge.rel === "financed" && hsbc.edge.provenance.source === "ch-charges", "financed edge with CH provenance");
    assert(hsbc!.edge.confidence > 0.8, "outstanding charge is high-confidence");
  });

  // --- Officers + PSC ingesters, and a shared-director bridge between two companies ---
  const g3 = new InMemoryGraphStore();
  await ingestOfficers(T, { chNumber: "111", name: "Alpha Ltd" }, { items: [{ name: "Jane Director", officer_role: "director", appointed_on: "2020-01-01" }] }, g3);
  await ingestOfficers(T, { chNumber: "222", name: "Beta Ltd" }, { items: [{ name: "Jane Director", officer_role: "director", appointed_on: "2021-01-01" }] }, g3);
  await ingestPsc(T, { chNumber: "222", name: "Beta Ltd" }, { items: [{ name: "Sponsor Holdings Ltd", kind: "corporate-entity-person-with-significant-control", natures_of_control: ["ownership-of-shares-75-to-100-percent"], notified_on: "2019-01-01" }] }, g3);
  const alphaToBeta = await warmestPaths(g3, T, ["co:111"], "co:222");

  suite("graph / officers + PSC");

  test("a shared director bridges two companies (a warm-path connector)", () => {
    assert(!!alphaToBeta, "path exists via the shared director");
    assert(alphaToBeta![0].hops.some((h) => h.rel === "officer_of"), "path runs through officer_of edges");
  });

  test("a corporate PSC seeds an owns edge from the sponsor vehicle", async () => {
    const owners = await g3.neighbours(T, "co:222");
    const sponsor = owners.find((n) => n.edge.rel === "owns");
    assert(!!sponsor && sponsor.edge.provenance.source === "ch-psc", "owns edge with PSC provenance");
    assert(sponsor!.node.kind === "firm", "corporate PSC is a firm node");
  });

  // --- Re-ingest must UPSERT an edge by id, never duplicate it (matches Postgres) ---
  suite("graph / edge dedup");

  const dg = new InMemoryGraphStore();
  await dg.addNode(node("a", "firm", "A"));
  await dg.addNode(node("b", "firm", "B"));
  await dg.addEdge(edge("dup", "a", "b", "knows", 0.7));
  await dg.addEdge(edge("dup", "a", "b", "knows", 0.9)); // same id, re-ingested with fresher confidence

  test("re-ingesting an edge by id upserts rather than duplicating", async () => {
    const nbrs = await dg.neighbours(T, "a");
    assertEqual(nbrs.length, 1, "one edge, not two, after a re-ingest");
    assertEqual(nbrs[0].edge.confidence, 0.9, "the fresher confidence wins the upsert");
  });
}
