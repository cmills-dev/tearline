// test/resolve.test.ts
// Graph entity resolution abstains rather than mis-links: a confident GLEIF match upgrades a
// name-only node to its LEI (resolved); an ambiguous one stays unresolved. Mock fetch, no key.

import { suite, test, assert, assertEqual } from "./harness";
import { InMemoryGraphStore } from "../lib/graph/store";
import { resolveGraphNodes } from "../lib/graph/resolve";
import type { GraphNode } from "../lib/graph/model";

const T = "tenant-1";
const jsonRes = (status: number, body: unknown) => ({ status, ok: status >= 200 && status < 300, json: async () => body } as unknown as Response);
const leiItem = (lei: string, name: string) => ({ id: lei, attributes: { entity: { legalName: { name }, legalAddress: { country: "GB" }, registeredAt: { id: "RA000585" } }, registration: { status: "ISSUED" } } });
const node = (id: string, name: string): GraphNode => ({ id, tenantId: T, kind: "firm", firmRole: "lender", displayName: name, resolutionConfidence: 0.5, resolutionStatus: "unresolved" });

suite("graph / entity resolution");

export async function registerResolveTests(): Promise<void> {
  const store = new InMemoryGraphStore();
  await store.addNode(node("firm:hsbc", "HSBC UK Bank plc"));
  await store.addNode(node("firm:vague", "Some Nominee Ltd"));

  // HSBC resolves to a single confident LEI; the vague name returns two near-equal -> abstain.
  const singleFetch = (async () => jsonRes(200, { data: [leiItem("2138HSBCUKBANK0000000", "HSBC UK BANK PLC")], meta: { pagination: { total: 1 } } })) as unknown as typeof fetch;
  await resolveGraphNodes(store, T, { fetchImpl: singleFetch });
  const hsbc = await store.getNode(T, "firm:hsbc");

  const store2 = new InMemoryGraphStore();
  await store2.addNode(node("firm:vague", "Some Nominee Ltd"));
  const ambiguousFetch = (async () => jsonRes(200, { data: [leiItem("A", "SOME NOMINEE LIMITED"), leiItem("B", "SOME NOMINEE LIMITED")], meta: { pagination: { total: 2 } } })) as unknown as typeof fetch;
  const r2 = await resolveGraphNodes(store2, T, { fetchImpl: ambiguousFetch });
  const vague = await store2.getNode(T, "firm:vague");

  test("a confident single match upgrades the node to its LEI (resolved)", () => {
    assert(!!hsbc && hsbc.lei === "2138HSBCUKBANK0000000", "LEI attached");
    assertEqual(hsbc!.resolutionStatus, "resolved", "marked resolved");
  });

  test("an ambiguous match abstains - the node stays unresolved, never mis-linked", () => {
    assertEqual(r2.abstained, 1, "one abstention");
    assert(!vague!.lei, "no LEI attached to an ambiguous node");
    assertEqual(vague!.resolutionStatus, "unresolved", "stays in the review band");
  });
}
