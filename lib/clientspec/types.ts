// lib/clientspec/types.ts
// Shared types for the client-understanding module (Module 1) and its onboarding flow. This
// is the stable seam every part of the module builds against: the induction engine
// (lib/clientspec/induce.ts), the persistence store (lib/clientspec/store.ts +
// lib/clientspec/postgres.ts), the renderer (lib/clientspec/render.ts) and the onboarding API
// routes (app/api/onboarding/*). Keeping the contracts here means those parts can be built
// independently and merged without stepping on each other.

import type { ClientSpec, ClientSpecField, ClientStyleTokens } from "../contracts/clientSpec";
import type { FactManifest, Rung } from "../engine/types";

export type { ClientSpec, ClientSpecField, ClientStyleTokens };

// ---------------------------------------------------------------------------
// Induction: an example tear sheet in, a ClientSpec + honest abstentions out.
// ---------------------------------------------------------------------------

export interface IngestInput {
  name?: string; // a human name for the example sheet, e.g. "Acme house sheet Q3"
  text: string; // the pasted / extracted text of the example tear sheet
}

export interface InducedSpec {
  spec: ClientSpec; // the induced spec (version 1; the store bumps the version on re-induction)
  // Field-bearing lines from the example we could NOT confidently map to an engine concept.
  // These are surfaced for analyst review, never silently dropped and never guessed onto a
  // concept, which is the module's honesty rule.
  unmapped: string[];
  mappedCount: number; // how many fields were bound to a concept
}

// ---------------------------------------------------------------------------
// Rendering: a ClientSpec + a FactManifest in, a spec-conformed view out.
// ---------------------------------------------------------------------------

export interface RenderedField {
  key: string; // engine concept key
  label: string; // the client's own label from the spec
  value: string | null; // formatted display value; null when abstained
  rung: Rung | null; // the resolution rung of the fact used, or null when abstained
  abstained: boolean; // true when no fact met the field's requirement (honest blank)
  belowFloor: boolean; // true when a fact existed but its rung was below the field's floor
  factId?: string; // the fact this field resolved from, when it resolved
}

export interface RenderedSection {
  title: string;
  fields: RenderedField[];
}

export interface RenderedSheet {
  clientId: string;
  specVersion: number;
  specName: string;
  entityName: string;
  sections: RenderedSection[];
  styleTokens: ClientStyleTokens;
  // A required field that abstained (or fell below its floor) blocks the sheet, per the
  // client's own spec. The block is surfaced honestly rather than papered over.
  blocked: boolean;
  blockingFields: string[]; // labels of the required fields that could not be served
}

// The renderer's signature (implemented in lib/clientspec/render.ts).
export type RenderAgainstSpec = (spec: ClientSpec, manifest: FactManifest) => RenderedSheet;

// The induction engine's signature (implemented in lib/clientspec/induce.ts). The optional
// opts carry the tenant's learned synonyms (RSI Phase 1), applied before the static dictionary.
export type InduceClientSpec = (input: IngestInput, clientId: string, opts?: InduceOptions) => InducedSpec;

// ---------------------------------------------------------------------------
// Onboarding progress: the state a tenant accumulates through the wizard.
// ---------------------------------------------------------------------------

export type OnboardingStepId = "desk" | "network" | "housesheet" | "review";

export const ONBOARDING_STEPS: OnboardingStepId[] = ["desk", "network", "housesheet", "review"];

// The desk's origination mandate, captured in the wizard's first step. Turnover bounds are in
// ABSOLUTE currency (not millions), matching MandateLike, so origination fit-scoring consumes it
// directly. Every field is optional: a desk that states nothing simply scores on catalyst alone.
export interface OnboardingMandate {
  sectors?: string[];
  minTurnover?: number;
  maxTurnover?: number;
  maxLeverage?: number;
}

export interface OnboardingState {
  tenantId: string;
  completedSteps: OnboardingStepId[]; // steps the tenant has finished
  activeSpecVersion: number | null; // the ClientSpec version currently active, if any
  firmName?: string; // captured in the desk step, echoed in the UI
  mandate?: OnboardingMandate; // captured in the desk step, used by origination fit-scoring
  complete: boolean; // true once the review step signs off
  updatedAt: string; // ISO
}

export function emptyOnboardingState(tenantId: string): OnboardingState {
  return { tenantId, completedSteps: [], activeSpecVersion: null, complete: false, updatedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// RSI Phase 1: the per-client feedback loop (in-silo, MNPI-safe).
// ---------------------------------------------------------------------------
// See docs/rsi-feedback-design.md. A client's confirmed corrections stay in their own tenant:
// a ClientSynonym is a label the client taught us maps to a concept, applied FIRST at induction
// so their vocabulary resolves on the next sheet. A FeedbackEvent is the audit trail of every
// correction. Neither ever leaves the tenant. (Promotion to a shared dictionary is a later,
// gated phase and is deliberately not in this seam.)

// A per-client learned mapping: the client confirmed that a label they use means a concept.
export interface ClientSynonym {
  labelNorm: string; // the normalised label (lib/clientspec/concepts.normaliseLabel)
  conceptKey: string; // the engine concept key it binds to
  sourceLabel: string; // the client's original wording, kept for display and audit
  confirmedAt: string; // ISO
}

export type FeedbackKind =
  | "abstention_resolved" // the client mapped a previously-unmapped label to a concept
  | "abstention_dismissed" // the client confirmed a label should stay out (no concept)
  | "label_edit" // the client relabelled a field
  | "required_toggle" // the client changed a field's required flag
  | "floor_change" // the client changed a field's resolution floor
  | "sheet_correction"; // the client corrected a rendered house sheet (Phase 4)

export interface FeedbackEvent {
  tenantId: string;
  kind: FeedbackKind;
  payload: Record<string, unknown>; // the specifics (label, concept, before/after)
  createdAt: string; // ISO
}

// Induction options: the caller passes the tenant's learned synonyms so they resolve before the
// static dictionary. Induction stays pure; the route fetches the synonyms and hands them in.
export interface InduceOptions {
  synonyms?: ClientSynonym[];
}

// ---------------------------------------------------------------------------
// RSI Phases 2 to 3: the SHARED plane (cross-tenant, de-identified, gated).
// ---------------------------------------------------------------------------
// See docs/rsi-feedback-design.md. This is the ONE place client vocabulary can, under strict
// gates, benefit other clients. It is deliberately NOT tenant-scoped: it lives outside the RLS
// wall on purpose, so it must never store client-identifying content. A candidate carries only
// the normalised label, the concept, and a COUNT of distinct tenants (dedup by one-way hash, so
// we never learn which tenant used which term). Promotion to the shared dictionary needs
// k-anonymity + a token filter + human sign-off + an induction-eval gate (all enforced outside
// this seam). No figure, no tenant id, no MNPI ever enters here.

export type CandidateStatus = "pending" | "queued" | "approved" | "rejected";

export interface SynonymCandidate {
  labelNorm: string; // the normalised label only (no raw client wording, no tenant id)
  conceptKey: string;
  distinctTenants: number; // how many DISTINCT tenants independently confirmed this mapping
  status: CandidateStatus;
}

export interface SharedDictionaryEntry {
  labelNorm: string;
  conceptKey: string;
}

export interface SharedDictionaryVersion {
  version: number; // monotonic, append-only
  entries: SharedDictionaryEntry[];
  approvedBy: string; // the analyst who signed off the promotion
  createdAt: string; // ISO
}

// The shared-plane store. GLOBAL, not tenant-scoped. Implemented in-memory and against Postgres
// (db/migrations/0008), selected by DATABASE_URL, like the other stores.
export interface SharedLearningStore {
  // Record that a tenant confirmed labelNorm -> conceptKey. The tenant is stored only as a
  // one-way hash so distinct tenants can be counted without ever knowing which tenant used the
  // term. Idempotent per tenant (a tenant confirming twice does not inflate the count).
  contribute(labelNorm: string, conceptKey: string, tenantId: string): Promise<void>;
  // Candidates, optionally filtered to those with at least minTenants distinct confirmers.
  listCandidates(minTenants?: number): Promise<SynonymCandidate[]>;
  // Move a candidate through the review workflow (queued / approved / rejected).
  setCandidateStatus(labelNorm: string, conceptKey: string, status: CandidateStatus): Promise<void>;
  // The entries of the active (latest) shared dictionary version, applied at induction after a
  // tenant's own synonyms and before the static base dictionary.
  activeEntries(): Promise<SharedDictionaryEntry[]>;
  activeVersion(): Promise<number>; // 0 when nothing has been promoted yet
  // Promote a set of entries as a new, append-only dictionary version. Callers must have already
  // passed the k-anonymity, token-filter, human-review and eval gates; this only persists.
  promote(entries: SharedDictionaryEntry[], approvedBy: string): Promise<number>;
  listVersions(): Promise<SharedDictionaryVersion[]>;
}

// ---------------------------------------------------------------------------
// Persistence seam: per-tenant ClientSpecs (versioned) + onboarding state.
// ---------------------------------------------------------------------------
// Implemented in-memory and against Postgres, selected by DATABASE_URL, exactly like the
// tear-sheet, monitor and shortlist stores.

export interface ClientSpecStore {
  // Save a spec for the tenant, assigning the next version (max existing + 1); returns the
  // version assigned. The spec's own `version` field is overwritten with it.
  saveSpec(tenantId: string, spec: ClientSpec): Promise<number>;
  // Every spec the tenant has saved, newest version first.
  listSpecs(tenantId: string): Promise<ClientSpec[]>;
  // The spec whose version equals the tenant's active pointer, or null if none is active.
  getActiveSpec(tenantId: string): Promise<ClientSpec | null>;
  // Point the tenant's active pointer at a saved version (also stored on OnboardingState).
  setActiveSpec(tenantId: string, version: number): Promise<void>;
  // Onboarding progress for the tenant (never null; a fresh tenant gets an empty state).
  getState(tenantId: string): Promise<OnboardingState>;
  setState(tenantId: string, state: OnboardingState): Promise<void>;

  // RSI Phase 1: per-client learned synonyms + the feedback audit trail (in-silo).
  // Upsert a learned synonym (by labelNorm) for the tenant.
  addSynonym(tenantId: string, syn: ClientSynonym): Promise<void>;
  // Every synonym the tenant has taught us.
  listSynonyms(tenantId: string): Promise<ClientSynonym[]>;
  // Append a feedback event to the tenant's audit trail.
  recordFeedback(tenantId: string, event: FeedbackEvent): Promise<void>;
  // The tenant's recent feedback events, newest first.
  listFeedback(tenantId: string, limit?: number): Promise<FeedbackEvent[]>;
}
