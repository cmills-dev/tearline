// lib/graph/model.ts
// The relationship graph: company <-> person <-> firm <-> deal, the spine of Engine C
// (origination) and the conversational onboarding. It reuses the tear-sheet discipline:
// every EDGE carries provenance and a confidence, nothing is a fabricated relationship,
// and an unresolved endpoint abstains into a review band rather than being guessed.
//
// Tenancy is first-class (every node/edge carries tenantId), and visibility separates a
// SHARED public-filing fact from a TENANT_PRIVATE relationship the client brought from
// their own CRM/mailbox. The private layer is what makes an intro actually "warm" and is
// never redistributed (the BYO-entitlement wall).

export type NodeKind = "company" | "person" | "firm" | "deal";
export type FirmRole = "pe" | "law" | "lender" | "bank" | "adviser" | "accountant";
export type ResolutionStatus = "resolved" | "unresolved" | "ambiguous";

export interface GraphNode {
  id: string;
  tenantId: string;
  kind: NodeKind;
  firmRole?: FirmRole; // when kind === "firm"
  displayName: string;
  // canonical identifiers, when resolved
  lei?: string;
  chNumber?: string;
  cik?: string;
  ocId?: string; // OpenCorporates id
  resolutionConfidence: number; // 0..1
  resolutionStatus: ResolutionStatus;
}

export type EdgeRel =
  | "advised"
  | "financed"
  | "sponsored"
  | "portfolio_of"
  | "works_at"
  | "officer_of"
  | "parent_of"
  | "owns"
  | "knows"
  | "introduced_by"
  | "party_to"; // links a party node to a deal hub

export type AssertionType = "assertion" | "inference";
export type Visibility = "shared" | "tenant_private";

export interface EdgeProvenance {
  source: string; // e.g. "ch-charges", "gleif-rr", "client-crm", "rns"
  sourceUrl?: string;
  evidenceQuote?: string; // the verbatim text that asserts the relationship
  retrievedAt: string; // ISO date
}

export interface GraphEdge {
  id: string;
  tenantId: string;
  srcId: string;
  dstId: string;
  rel: EdgeRel;
  assertionType: AssertionType; // "assertion" = directly stated in a source; "inference" = derived
  confidence: number; // 0..1 in the assertion itself
  strength?: number; // 0..1 relationship strength (e.g. CRM interaction density)
  validFrom?: string;
  validTo?: string;
  visibility: Visibility;
  provenance: EdgeProvenance;
}

// The pre-resolution audit trail: a raw name mentioned in a source and how (or whether) it
// resolved to a node. An "abstained" match is kept for a human review queue, never silently
// dropped and never force-linked.
export interface NodeMention {
  rawName: string;
  source: string;
  sourceUrl?: string;
  resolvedNodeId?: string;
  matchScore?: number;
  matchedBy: "lei" | "ch_number" | "cik" | "name_jaro" | "abstained";
}

// A warm-introduction path from the client firm to a target, hop by hop, each hop carrying
// its own provenance so the "why you" is auditable. warmestPaths returns null to ABSTAIN
// when no path clears the confidence floor.
export interface IntroHop {
  fromId: string;
  toId: string;
  rel: EdgeRel;
  provenance: EdgeProvenance;
}
export interface WarmPath {
  hops: IntroHop[];
  totalCost: number;
  minConfidence: number;
}

// Invariant guard: an edge must carry provenance and be an assertion unless explicitly an
// inference; a fabricated (provenance-less) relationship can never enter the graph.
export function isPersistableEdge(e: GraphEdge): boolean {
  if (!e.srcId || !e.dstId || !e.rel) return false;
  if (!e.provenance || !e.provenance.source) return false;
  if (e.confidence < 0 || e.confidence > 1) return false;
  return true;
}
