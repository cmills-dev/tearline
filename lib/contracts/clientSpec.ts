// lib/contracts/clientSpec.ts
// ClientSpec v0 - the Module 1 (client-understanding) output contract. A ClientSpec is
// induced from a client's example tear sheets: the fields their house sheet wants, each
// bound to an ontology concept and a minimum acceptable resolution rung, plus the style
// tokens and the section skeleton their output is served into. It is versioned so a
// re-induction can supersede an earlier spec without losing provenance of which version
// produced a given tear sheet.
//
// This is a frozen contract: additive changes only within a major; a breaking change
// bumps CONTRACT_VERSION (see ./index.ts) and requires a migration.

import type { Rung } from "../engine/types";

// A single field the client's tear sheet expects, bound to the engine's concept space.
export interface ClientSpecField {
  key: string; // engine metric / concept key, e.g. "ebitda"
  label: string; // the client's own label for it, e.g. "Adjusted EBITDA"
  ontologyConcept: string; // bound ontology concept id (Module 2 / ontology)
  required: boolean; // whether an abstain on this field blocks the sheet
  // The lowest rung the client will accept for this field. A field with floor "R1"
  // will not accept a synthesised or proxied value; one with "R3" tolerates a labelled
  // proxy. Never below the ladder: R4 (abstain) is always a permitted outcome.
  resolutionFloor?: Rung;
  format?: "currency" | "ratio" | "percent" | "integer" | "text";
}

// Presentation tokens the intelligence layer serves the sheet to. Deliberately small in
// v0: the discipline (tabular figures, analyst-understated voice) is engine-wide; these
// are the client-specific overrides.
export interface ClientStyleTokens {
  voice: string; // e.g. "analyst-understated"
  numberStyle: "tabular";
  dateFormat: string; // e.g. "D MMM YYYY"
  currencyDefault: string; // e.g. "GBP"
}

export interface ClientSpec {
  contractVersion: string; // the CONTRACT_VERSION that produced this spec
  clientId: string;
  version: number; // monotonically increasing per client on re-induction
  name: string; // human label for the spec
  fields: ClientSpecField[];
  styleTokens: ClientStyleTokens;
  skeleton: string[]; // ordered section slots the output fills, e.g. ["Header", "Financials", "Capital structure", "Position"]
  inducedFrom: string[]; // ids/names of the example tear sheets this was induced from
  createdAt: string; // ISO date
}
