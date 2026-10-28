// lib/graph/ingest/companiesHouse.ts
// One call to populate a company's neighbourhood in the relationship graph from Companies
// House: its lenders (charges), its people (officers), and its owners (PSC), plus its
// ultimate parent (GLEIF). Best-effort and tenant-scoped: any single source failing leaves
// the others intact, and every edge carries the filing it came from. Nothing is inferred.

import type { GraphStore } from "../store";
import { getProfile, getCharges, getOfficers, getPsc } from "../../sources/companiesHouseLive";
import { resolveLei } from "../../sources/gleif";
import { ingestCharges } from "./chCharges";
import { ingestOfficers } from "./chOfficers";
import { ingestPsc } from "./chPsc";
import type { GraphEdge } from "../model";

export interface NetworkIngestResult {
  company: { chNumber: string; name: string };
  charges: number;
  officers: number;
  owners: number;
  parentLei?: string;
}

export async function ingestCompanyNetwork(tenantId: string, chNumber: string, store: GraphStore): Promise<NetworkIngestResult> {
  const profile = await getProfile(chNumber);
  const company = { chNumber, name: profile.company_name };
  const result: NetworkIngestResult = { company, charges: 0, officers: 0, owners: 0 };

  const [charges, officers, psc, lei] = await Promise.all([
    getCharges(chNumber).catch(() => ({ items: [], total_count: 0 })),
    getOfficers(chNumber).catch(() => ({ items: [] })),
    getPsc(chNumber).catch(() => ({ items: [] })),
    resolveLei(profile.company_name, { chNumber, withParents: true }).catch(() => null),
  ]);

  result.charges = (await ingestCharges(tenantId, company, charges, store)).seeded;
  result.officers = (await ingestOfficers(tenantId, company, officers, store)).seeded;
  result.owners = (await ingestPsc(tenantId, company, psc, store)).seeded;

  // Ultimate parent as a parent_of edge (from GLEIF relationship data), when resolved.
  if (lei?.ultimateParentLei) {
    const parentId = `firm:lei:${lei.ultimateParentLei}`;
    await store.addNode({ id: parentId, tenantId, kind: "firm", displayName: `Ultimate parent (${lei.ultimateParentLei})`, lei: lei.ultimateParentLei, resolutionConfidence: 0.9, resolutionStatus: "resolved" });
    const edge: GraphEdge = {
      id: `parent:${chNumber}`,
      tenantId,
      srcId: parentId,
      dstId: `co:${chNumber}`,
      rel: "parent_of",
      assertionType: "assertion",
      confidence: 0.9,
      visibility: "shared",
      provenance: { source: "gleif-rr", sourceUrl: `https://search.gleif.org/#/record/${lei.ultimateParentLei}`, evidenceQuote: "GLEIF ultimate-parent relationship", retrievedAt: new Date().toISOString().slice(0, 10) },
    };
    await store.addEdge(edge);
    result.parentLei = lei.ultimateParentLei;
  }

  return result;
}
