// test/originate.test.ts
// Engine C: a target is surfaced only with a CITED catalyst; a warm intro path lifts it
// above an equal-catalyst cold target; a target with no catalyst abstains. No fabrication:
// every whyNow signal carries provenance and every path hop is provenanced.

import { suite, test, assert, assertEqual } from "./harness";
import { InMemoryGraphStore } from "../lib/graph/store";
import { originate, type Candidate } from "../lib/originate/engine";
import type { FactManifest, Fact, Provenance } from "../lib/engine/types";
import type { GraphNode, GraphEdge } from "../lib/graph/model";

const T = "tenant-1";
const prov = (s: string): Provenance => ({
  sourceId: s, tag: "Acc", documentName: s, locator: "http://x", snippet: s, retrievedAt: "2026-01-01", contentHash: "h",
});
const fact = (metric: string, value: number | string, rung: Fact["rung"] = "R1"): Fact => ({
  id: `${metric}.FY2024`, metric, label: metric, period: "FY2024", kind: typeof value === "number" ? "currency" : "text",
  value, unit: "GBP", rung, provenance: prov(metric), verification: { status: "SINGLE_SOURCE", checks: [] },
});
const manifest = (name: string, facts: Fact[]): FactManifest => ({
  entity: { companyName: name, companyNumber: name, jurisdiction: "GB", status: "active", incorporatedOn: "", sicCodes: [], registeredOffice: "", accountsType: "full", latestPeriodEnd: "2024-12-31", synthetic: false },
  facts: Object.fromEntries(facts.map((f) => [f.id, f])), sources: {}, generatedAt: "2026-01-01",
});

const node = (id: string, kind: GraphNode["kind"], name: string): GraphNode => ({ id, tenantId: T, kind, displayName: name, resolutionConfidence: 1, resolutionStatus: "resolved" });
const edge = (id: string, src: string, dst: string, rel: GraphEdge["rel"], conf: number): GraphEdge => ({ id, tenantId: T, srcId: src, dstId: dst, rel, assertionType: "assertion", confidence: conf, visibility: "shared", provenance: { source: "test", retrievedAt: "2026-01-01" } });

const mandate = { sectors: ["software"], minTurnover: 10e6, maxTurnover: 100e6 };

suite("originate / Engine C");

export async function registerOriginateTests(): Promise<void> {
  const store = new InMemoryGraphStore();
  await store.addNode(node("myfirm", "firm", "Our Firm"));
  await store.addNode(node("alice", "person", "Alice"));
  await store.addNode(node("acme", "company", "Acme"));
  await store.addEdge(edge("e1", "myfirm", "alice", "knows", 0.9));
  await store.addEdge(edge("e2", "alice", "acme", "advised", 0.8));

  const candidates: Candidate[] = [
    { targetNodeId: "acme", name: "Acme", manifest: manifest("Acme", [fact("leverage", 6.0, "R2"), fact("sector", "software"), fact("turnover", 50e6), fact("charge1", "outstanding")]) },
    { targetNodeId: "coldco", name: "ColdCo", manifest: manifest("ColdCo", [fact("leverage", 5.5, "R2"), fact("sector", "software"), fact("turnover", 40e6)]) },
    { targetNodeId: "nocat", name: "NoCatalyst", manifest: manifest("NoCatalyst", [fact("sector", "software"), fact("turnover", 30e6)]) },
  ];

  const result = await originate({ mandate, tenantId: T, fromIds: ["myfirm"], candidates, store });
  const acme = result.suggestions.find((s) => s.target.name === "Acme");
  const cold = result.suggestions.find((s) => s.target.name === "ColdCo");

  suite("originate / Engine C");

  test("surfaces a target with a cited catalyst and shows the warm intro path", () => {
    assert(!!acme, "Acme surfaced");
    assertEqual(acme!.tier, "warm", "warm (a path exists)");
    assert(acme!.whyNow.some((s) => s.type === "high_leverage" && !!s.source), "cited high-leverage catalyst");
    assert(!!acme!.warmPath && acme!.warmPath.hops.length === 2, "myfirm -> alice -> acme");
    assert(acme!.warmPath!.hops.every((h) => !!h.provenance.source), "every hop cited");
  });

  test("a strong catalyst with no path is surfaced but demoted to cold", () => {
    assert(!!cold && cold.tier === "cold", "ColdCo is cold");
    assertEqual(cold!.warmPath, null, "no fabricated path");
  });

  test("the warm target ranks above the equal-catalyst cold target", () => {
    assert(acme!.score.total > cold!.score.total, "warm outranks cold via the path gate");
  });

  test("a target with no cited catalyst abstains (never surfaced)", () => {
    assert(result.abstained.some((a) => a.name === "NoCatalyst"), "NoCatalyst abstained");
    assert(!result.suggestions.some((s) => s.target.name === "NoCatalyst"), "not in suggestions");
  });
}
