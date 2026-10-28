// lib/onboarding/machine.ts
// The deterministic onboarding flow: an ordered set of slots, each with the question to ask
// and the JSON shape the user's answer should be parsed into. The flow is code, not the
// model - the model only fills a slot from the user's words. This keeps the conversation
// auditable and prevents an LLM from wandering or inventing structure.

import type { OnboardingProfile } from "./profile";

export type SlotId = "firmName" | "mandateSectors" | "mandateSize" | "relationships" | "constraints" | "confirm";

export interface Step {
  slot: SlotId;
  question: string;
  // JSON schema hint given to the extractor for this slot.
  schemaHint: string;
}

export const STEPS: Step[] = [
  {
    slot: "firmName",
    question: "To start, what is your firm's name?",
    schemaHint: `{ "firmName": string | null }`,
  },
  {
    slot: "mandateSectors",
    question: "Which sectors or situations does your desk focus on? (e.g. software, healthcare, special situations)",
    schemaHint: `{ "sectors": string[] }`,
  },
  {
    slot: "mandateSize",
    question: "What size of companies do you target? Give a turnover range if you can (e.g. £10m to £100m).",
    schemaHint: `{ "minTurnover": number | null, "maxTurnover": number | null }  // in pounds`,
  },
  {
    slot: "relationships",
    question:
      "Who do you know well that helps you win work - PE sponsors, law firms, lenders, advisers? Name them, their type, and how close (1-5). List as many as you like.",
    schemaHint: `{ "relationships": [ { "counterpartyName": string, "counterpartyType": "pe"|"law"|"lender"|"bank"|"adviser"|"accountant"|"company", "relationship": "know"|"worked_with"|"introduced_by"|"co_invested", "strength": 1|2|3|4|5, "note": string | null } ] }`,
  },
  {
    slot: "constraints",
    question: "Any no-go areas or hard constraints we should never suggest? (sectors, regions, names)",
    schemaHint: `{ "constraints": string[] }`,
  },
];

// The next slot to ask about, or null when every REQUIRED slot is filled and every optional slot has
// been asked once. firmName and sectors are required (a desk needs a name and a focus); size,
// relationships and constraints are optional-but-asked - asked once, then skipped even if left
// empty, tracked via profile.answeredSlots so onboarding cannot loop on a desk that has no size
// range or no relationships to state. Pure: the "asked" state lives on the profile, set by runTurn.
export function nextStep(profile: OnboardingProfile): Step | null {
  const answered = new Set(profile.answeredSlots ?? []);
  if (!profile.firmName) return STEPS[0];
  if (!profile.mandate.sectors || profile.mandate.sectors.length === 0) return STEPS[1];
  if (profile.mandate.minTurnover === undefined && profile.mandate.maxTurnover === undefined && !answered.has("mandateSize")) return STEPS[2];
  if (profile.relationships.length === 0 && !answered.has("relationships")) return STEPS[3];
  if (!profile.confirmed && profile.constraints.length === 0 && !answered.has("constraints")) return STEPS[4];
  return null;
}

export function progress(profile: OnboardingProfile): { filled: number; total: number } {
  let filled = 0;
  if (profile.firmName) filled++;
  if (profile.mandate.sectors?.length) filled++;
  if (profile.mandate.minTurnover !== undefined || profile.mandate.maxTurnover !== undefined) filled++;
  if (profile.relationships.length) filled++;
  return { filled, total: 4 };
}
