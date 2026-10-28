// lib/onboarding/profile.ts
// The typed profile the conversational onboarding fills. The AI never decides these values;
// it only PARSES the user's free-text answers into these typed slots, and every captured
// fact is confirmed with the user before it is kept. Relationships are stored with a
// "stated by the client" provenance and seed the relationship graph as tenant-private edges.

export type CounterpartyType = "pe" | "law" | "lender" | "bank" | "adviser" | "accountant" | "company";
export type RelationshipKind = "know" | "worked_with" | "introduced_by" | "co_invested";

export interface RelationshipAssertion {
  counterpartyName: string;
  counterpartyType: CounterpartyType;
  relationship: RelationshipKind;
  strength: 1 | 2 | 3 | 4 | 5; // 1 = weak, 5 = very close
  note?: string;
}

export interface OnboardingMandate {
  sectors?: string[];
  minTurnover?: number;
  maxTurnover?: number;
  maxLeverage?: number;
  strategy?: string;
}

export interface OnboardingProfile {
  firmName?: string;
  mandate: OnboardingMandate;
  relationships: RelationshipAssertion[];
  constraints: string[]; // no-go areas / hard exclusions the user stated
  confirmed: boolean;
  // The slots already ASKED-AND-ANSWERED (by slot id). Persisted ON the profile because the
  // conversation is stateless across HTTP turns - it round-trips as JSON, so a process-side WeakSet
  // keyed on object identity never matched, re-asking the optional slots forever. An OPTIONAL slot
  // (size, relationships, constraints) is asked once, then not re-asked even if the user left it
  // empty, so onboarding cannot loop when a desk has no size range or no relationships to state.
  answeredSlots?: string[];
}

export function emptyProfile(): OnboardingProfile {
  return { mandate: {}, relationships: [], constraints: [], confirmed: false, answeredSlots: [] };
}

// A profile as it arrives from the browser. The conversation is stateless, so the client sends
// the whole profile back on every turn, and it can send anything: `{"profile":{"firmName":"x"}}`
// has no mandate, and the first slot check read `profile.mandate.sectors` and threw (WP-QA03).
// This keeps the typed shape: every container present and of the right kind, every scalar of
// its declared type or absent. It does not judge the values; the conversation still confirms them.
export function profileFromWire(value: unknown): OnboardingProfile {
  const base = emptyProfile();
  if (!isRecord(value)) return base;
  const m = isRecord(value.mandate) ? value.mandate : {};
  const mandate: OnboardingMandate = {};
  if (Array.isArray(m.sectors)) mandate.sectors = m.sectors.filter((s): s is string => typeof s === "string");
  for (const k of ["minTurnover", "maxTurnover", "maxLeverage"] as const) {
    if (typeof m[k] === "number" && Number.isFinite(m[k])) mandate[k] = m[k] as number;
  }
  if (typeof m.strategy === "string") mandate.strategy = m.strategy;
  return {
    ...(typeof value.firmName === "string" ? { firmName: value.firmName } : {}),
    mandate,
    relationships: Array.isArray(value.relationships)
      ? (value.relationships.filter((r) => isRecord(r) && typeof r.counterpartyName === "string") as unknown as RelationshipAssertion[])
      : [],
    constraints: Array.isArray(value.constraints)
      ? value.constraints.filter((c): c is string => typeof c === "string")
      : [],
    confirmed: value.confirmed === true,
    answeredSlots: Array.isArray(value.answeredSlots)
      ? value.answeredSlots.filter((s): s is string => typeof s === "string")
      : [],
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
