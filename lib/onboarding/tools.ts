// lib/onboarding/tools.ts
// The validated "tools" the onboarding fills. Each applies a parsed slot value to the typed
// profile and, for relationships, SEEDS the relationship graph with tenant-private edges
// whose provenance is "stated by the client". Nothing is invented: an empty/absent value is
// simply not applied, and a relationship the user did not state produces no edge.

import type { OnboardingProfile, RelationshipAssertion, CounterpartyType, RelationshipKind } from "./profile";
import type { SlotId } from "./machine";
import type { GraphStore } from "../graph/store";
import type { GraphNode, GraphEdge } from "../graph/model";

export const CLIENT_FIRM_NODE = "client-firm";

export interface ApplyContext {
  tenantId: string;
  store?: GraphStore; // when present, relationships seed the graph
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const today = () => new Date().toISOString().slice(0, 10);

const VALID_TYPES = new Set<CounterpartyType>(["pe", "law", "lender", "bank", "adviser", "accountant", "company"]);
const VALID_RELS = new Set<RelationshipKind>(["know", "worked_with", "introduced_by", "co_invested"]);

function cleanRelationship(r: unknown): RelationshipAssertion | null {
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  const name = typeof o.counterpartyName === "string" ? o.counterpartyName.trim() : "";
  const type = o.counterpartyType as CounterpartyType;
  const rel = (o.relationship as RelationshipKind) ?? "know";
  const strengthRaw = Number(o.strength);
  if (!name || !VALID_TYPES.has(type)) return null;
  const strength = (Math.min(5, Math.max(1, Math.round(strengthRaw || 3))) as 1 | 2 | 3 | 4 | 5);
  return {
    counterpartyName: name,
    counterpartyType: type,
    relationship: VALID_RELS.has(rel) ? rel : "know",
    strength,
    note: typeof o.note === "string" ? o.note : undefined,
  };
}

// Apply one slot's parsed value. Returns the number of relationship edges seeded (0 unless
// this was the relationships slot and a store was supplied).
export async function applyExtraction(
  profile: OnboardingProfile,
  slot: SlotId,
  value: unknown,
  ctx: ApplyContext,
): Promise<{ seeded: number }> {
  const v = (value ?? {}) as Record<string, unknown>;
  switch (slot) {
    case "firmName": {
      if (typeof v.firmName === "string" && v.firmName.trim()) {
        profile.firmName = v.firmName.trim();
        if (ctx.store) {
          const firmNode: GraphNode = { id: CLIENT_FIRM_NODE, tenantId: ctx.tenantId, kind: "firm", displayName: profile.firmName, resolutionConfidence: 1, resolutionStatus: "resolved" };
          await ctx.store.addNode(firmNode);
        }
      }
      return { seeded: 0 };
    }
    case "mandateSectors": {
      if (Array.isArray(v.sectors)) profile.mandate.sectors = v.sectors.filter((s): s is string => typeof s === "string" && !!s.trim()).map((s) => s.trim());
      return { seeded: 0 };
    }
    case "mandateSize": {
      if (typeof v.minTurnover === "number") profile.mandate.minTurnover = v.minTurnover;
      if (typeof v.maxTurnover === "number") profile.mandate.maxTurnover = v.maxTurnover;
      return { seeded: 0 };
    }
    case "relationships": {
      const list = Array.isArray(v.relationships) ? v.relationships : [];
      let seeded = 0;
      for (const raw of list) {
        const r = cleanRelationship(raw);
        if (!r) continue;
        profile.relationships.push(r);
        if (ctx.store) {
          // Use the SAME id scheme as the filing-derived ingesters (firm:/co: + name slug),
          // so a counterparty the client knows and the same counterparty named on a target's
          // charge/PSC resolve to ONE node - which is what lets a warm path connect the two.
          const cpId = r.counterpartyType === "company" ? `co:${slug(r.counterpartyName)}` : `firm:${slug(r.counterpartyName)}`;
          const cpNode: GraphNode = {
            id: cpId, tenantId: ctx.tenantId, kind: r.counterpartyType === "company" ? "company" : "firm",
            firmRole: r.counterpartyType === "company" ? undefined : mapRole(r.counterpartyType),
            displayName: r.counterpartyName, resolutionConfidence: 0.6, resolutionStatus: "unresolved",
          };
          await ctx.store.addNode(cpNode);
          const edge: GraphEdge = {
            id: `onb:${CLIENT_FIRM_NODE}:${cpId}`,
            tenantId: ctx.tenantId,
            srcId: CLIENT_FIRM_NODE,
            dstId: cpId,
            rel: r.relationship === "introduced_by" ? "introduced_by" : "knows",
            assertionType: "assertion",
            confidence: 0.5 + r.strength * 0.1, // stated closeness -> confidence
            strength: r.strength / 5,
            visibility: "tenant_private",
            provenance: { source: "client-onboarding", evidenceQuote: r.note ?? `Client stated they ${r.relationship.replace("_", " ")} ${r.counterpartyName}`, retrievedAt: today() },
          };
          await ctx.store.addEdge(edge);
          seeded++;
        }
      }
      return { seeded };
    }
    case "constraints": {
      if (Array.isArray(v.constraints)) profile.constraints.push(...v.constraints.filter((s): s is string => typeof s === "string" && !!s.trim()));
      return { seeded: 0 };
    }
    default:
      return { seeded: 0 };
  }
}

function mapRole(t: CounterpartyType): GraphNode["firmRole"] {
  if (t === "pe") return "pe";
  if (t === "law") return "law";
  if (t === "lender") return "lender";
  if (t === "bank") return "bank";
  if (t === "accountant") return "accountant";
  return "adviser";
}
