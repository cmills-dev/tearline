// lib/graph/ingest/chCharges.ts
// Populate the SHARED (public-filing) layer of the relationship graph from Companies House
// charges. A registered charge names the chargee - the lender - so each charge becomes a
// FINANCED edge (lender -> company) carrying the charge's own text as provenance. This is a
// real, no-fabrication relationship: it is filed at Companies House. Entity resolution of
// the lender name is left conservative (unresolved node) until the resolver runs; the edge
// itself is a filed fact regardless.

import type { ChargesList, ChargeItem } from "../../sources/companiesHouse";
import type { GraphStore } from "../store";
import type { GraphNode, GraphEdge } from "../model";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const today = () => new Date().toISOString().slice(0, 10);

function chargeeName(charge: ChargeItem): string | null {
  const n = charge.persons_entitled?.[0]?.name;
  return n && n.trim() ? n.trim() : null;
}

// Ingest one company's charges. Returns the number of financed edges seeded.
export async function ingestCharges(
  tenantId: string,
  company: { chNumber: string; name: string },
  charges: ChargesList,
  store: GraphStore,
): Promise<{ seeded: number; lenders: string[] }> {
  const companyId = `co:${company.chNumber}`;
  const companyNode: GraphNode = {
    id: companyId, tenantId, kind: "company", displayName: company.name,
    chNumber: company.chNumber, resolutionConfidence: 1, resolutionStatus: "resolved",
  };
  await store.addNode(companyNode);

  const lenders: string[] = [];
  let seeded = 0;
  for (const charge of charges.items ?? []) {
    const lender = chargeeName(charge);
    if (!lender) continue;
    const lenderId = `firm:${slug(lender)}`;
    const lenderNode: GraphNode = {
      id: lenderId, tenantId, kind: "firm", firmRole: "lender", displayName: lender,
      resolutionConfidence: 0.5, resolutionStatus: "unresolved", // name-only until resolved to an LEI/CH id
    };
    await store.addNode(lenderNode);

    const status = (charge.status ?? "").toLowerCase();
    const desc = charge.secured_details?.description ?? charge.classification?.description ?? "Registered charge";
    const edge: GraphEdge = {
      id: `chg:${company.chNumber}:${charge.charge_number}`,
      tenantId,
      srcId: lenderId,
      dstId: companyId,
      rel: "financed",
      assertionType: "assertion", // a filed charge is a stated fact
      confidence: status.includes("outstanding") ? 0.9 : 0.7, // satisfied charges are weaker/older
      validFrom: charge.created_on,
      visibility: "shared",
      provenance: {
        source: "ch-charges",
        sourceUrl: `https://find-and-update.company-information.service.gov.uk/company/${company.chNumber}/charges`,
        evidenceQuote: `${lender} - ${desc} (charge ${charge.charge_number}, ${charge.status})`,
        retrievedAt: today(),
      },
    };
    await store.addEdge(edge);
    lenders.push(lender);
    seeded++;
  }
  return { seeded, lenders };
}
