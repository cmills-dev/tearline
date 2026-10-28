// lib/contracts/index.ts
// THE FROZEN CONTRACT SURFACE. This is the single, versioned place that declares the
// domain contracts the rest of the system (persistence, ingestion, the API, clients)
// binds to. The types themselves still live next to the code that produces them; this
// module makes the canonical set explicit and stamps a version on it.
//
// Evolution rule: additive changes (a new optional field, a new metric) keep the major
// version. A BREAKING change (removing/renaming a field, changing a type, tightening a
// rung meaning) bumps CONTRACT_VERSION's major and REQUIRES a data migration. Persisted
// records carry the CONTRACT_VERSION they were written under (see lib/store).
//
// See docs/contracts.md for the human description.

export const CONTRACT_VERSION = "0.1.0";

// --- Core fact / evidence / verification contracts (Module 2 + intelligence layer) ---
export type {
  Fact,
  FactManifest,
  Provenance,
  ProvenanceTag,
  EvidenceCard,
  VerificationState,
  VerificationCheck,
  VerificationStatus,
  EntityMeta,
  Rung,
  FactValueKind,
  SourceDocument,
  AttemptLogEntry,
  Derivation,
  ProxyInfo,
} from "../engine/types";
export { RUNG_META } from "../engine/types";

// --- Engine B mandate contract (origination screen) ---
export type {
  MandateSpec,
  SizeBand,
  LeverageBand,
  RegionKey,
  SectorKey,
  SituationTagKey,
  SizeMetric,
} from "../engineB/mandate";

// --- Module 1 client-understanding contract ---
export type { ClientSpec, ClientSpecField, ClientStyleTokens } from "./clientSpec";
