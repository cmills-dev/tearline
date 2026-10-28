// lib/graph/ingest/chOfficers.ts
// Populate the graph's PEOPLE layer from Companies House officers. A director appointment is
// a filed fact: it becomes a person node + an OFFICER_OF edge (person -> company). Shared
// directors are how two companies connect through a person, a common warm-path bridge.
// Resigned officers get a lower confidence (a weaker/older link), never dropped silently.

import type { GraphStore } from "../store";
import type { GraphNode, GraphEdge } from "../model";

export interface OfficerItem {
  name: string;
  officer_role?: string; // "director", "secretary", ...
  appointed_on?: string;
  resigned_on?: string;
}
export interface OfficerList {
  items?: OfficerItem[];
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const today = () => new Date().toISOString().slice(0, 10);

export async function ingestOfficers(
  tenantId: string,
  company: { chNumber: string; name: string },
  officers: OfficerList,
  store: GraphStore,
): Promise<{ seeded: number }> {
  const companyId = `co:${company.chNumber}`;
  await store.addNode({ id: companyId, tenantId, kind: "company", displayName: company.name, chNumber: company.chNumber, resolutionConfidence: 1, resolutionStatus: "resolved" });

  let seeded = 0;
  for (const o of officers.items ?? []) {
    const name = o.name?.trim();
    if (!name) continue;
    const personId = `person:${slug(name)}`;
    const personNode: GraphNode = { id: personId, tenantId, kind: "person", displayName: name, resolutionConfidence: 0.7, resolutionStatus: "unresolved" };
    await store.addNode(personNode);
    const edge: GraphEdge = {
      id: `off:${company.chNumber}:${slug(name)}`,
      tenantId,
      srcId: personId,
      dstId: companyId,
      rel: "officer_of",
      assertionType: "assertion",
      confidence: o.resigned_on ? 0.5 : 0.9,
      validFrom: o.appointed_on,
      validTo: o.resigned_on,
      visibility: "shared",
      provenance: {
        source: "ch-officers",
        sourceUrl: `https://find-and-update.company-information.service.gov.uk/company/${company.chNumber}/officers`,
        evidenceQuote: `${name} - ${o.officer_role ?? "officer"}${o.resigned_on ? " (resigned)" : ""}`,
        retrievedAt: today(),
      },
    };
    await store.addEdge(edge);
    seeded++;
  }
  return { seeded };
}
