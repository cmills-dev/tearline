// lib/graph/ingest/chPsc.ts
// Populate the OWNERSHIP layer from Companies House persons-with-significant-control. A PSC
// is a filed fact: it becomes a person or firm node + an OWNS edge (owner -> company). A
// corporate PSC (an ultimate parent or a PE holding vehicle) is exactly the sponsor link an
// origination desk wants to trace.

import type { GraphStore } from "../store";
import type { GraphNode, GraphEdge } from "../model";

export interface PscItem {
  name: string;
  kind?: string; // "individual-person-with-significant-control" | "corporate-entity-..."
  natures_of_control?: string[];
  notified_on?: string;
  ceased_on?: string;
}
export interface PscList {
  items?: PscItem[];
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const today = () => new Date().toISOString().slice(0, 10);

export async function ingestPsc(
  tenantId: string,
  company: { chNumber: string; name: string },
  psc: PscList,
  store: GraphStore,
): Promise<{ seeded: number }> {
  const companyId = `co:${company.chNumber}`;
  await store.addNode({ id: companyId, tenantId, kind: "company", displayName: company.name, chNumber: company.chNumber, resolutionConfidence: 1, resolutionStatus: "resolved" });

  let seeded = 0;
  for (const p of psc.items ?? []) {
    const name = p.name?.trim();
    if (!name) continue;
    const corporate = (p.kind ?? "").includes("corporate") || (p.kind ?? "").includes("legal-person");
    const ownerId = corporate ? `firm:${slug(name)}` : `person:${slug(name)}`;
    const ownerNode: GraphNode = {
      id: ownerId, tenantId, kind: corporate ? "firm" : "person",
      firmRole: corporate ? "pe" : undefined, // a corporate PSC is often a sponsor vehicle; resolver refines
      displayName: name, resolutionConfidence: 0.6, resolutionStatus: "unresolved",
    };
    await store.addNode(ownerNode);
    const edge: GraphEdge = {
      id: `psc:${company.chNumber}:${slug(name)}`,
      tenantId,
      srcId: ownerId,
      dstId: companyId,
      rel: "owns",
      assertionType: "assertion",
      confidence: p.ceased_on ? 0.5 : 0.9,
      validFrom: p.notified_on,
      validTo: p.ceased_on,
      visibility: "shared",
      provenance: {
        source: "ch-psc",
        sourceUrl: `https://find-and-update.company-information.service.gov.uk/company/${company.chNumber}/persons-with-significant-control`,
        evidenceQuote: `${name}${p.natures_of_control?.length ? " - " + p.natures_of_control.join(", ") : ""}${p.ceased_on ? " (ceased)" : ""}`,
        retrievedAt: today(),
      },
    };
    await store.addEdge(edge);
    seeded++;
  }
  return { seeded };
}
