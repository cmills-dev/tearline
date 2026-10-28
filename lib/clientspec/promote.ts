// lib/clientspec/promote.ts
// RSI Phase 3: the PROMOTION POLICY for the shared vocabulary dictionary. These are the pure,
// deterministic gates that decide whether a cross-tenant synonym candidate may enter the shared
// dictionary. There is NO I/O here: no store, no network, no clock. The store (SharedLearningStore)
// gathers candidates and persists promotions; this module only judges. Keeping the policy pure
// means it is trivially testable and every promotion decision is reproducible from its inputs.
//
// Doctrine (docs/rsi-feedback-design.md, "Tier 2: shared-dictionary promotion"): a client's
// signature terminology must never cross the MNPI wall. So we reject on uncertainty. A candidate
// that fails ANY gate is never promoted, and the human sign-off + eval gates still sit OUTSIDE
// this seam. These functions cover the two gates that can be decided from de-identified data
// alone: k-anonymity (enough independent tenants) and an identifying-token filter.

import type { SynonymCandidate, SharedDictionaryEntry } from "./types";
import { matchConcept, conceptForKey } from "./concepts";
import { isAnonymousTenant } from "../auth/tenantCookie";

// The k-anonymity threshold. A mapping needs at least this many DISTINCT tenants independently
// confirming it before it counts as generic industry vocabulary rather than one desk's signature.
export const DEFAULT_K = 3;

// Who counts toward k (WP-QA05). Only a VERIFIED identity: a tenant bound to a signed-in session,
// which today is one registered account. An anonymous tenant (`anon_`, the old "anon" fallback, or
// no tenant) counts for nothing, because a new one costs a cleared cookie, so three of them are one
// actor. Both shared stores drop an anonymous contribution before it is hashed, and the feedback
// route contributes only under a verified session, so a count can never include one.
// What this does not close: registration has no email check, so one actor with three accounts
// still meets k=3. The register throttle (10 per IP per hour) slows that; human sign-off on every
// promotion is what stops it.
export function countsTowardK(tenantId: string): boolean {
  return !isAnonymousTenant(tenantId);
}

// Gate 1: k-anonymity. A term one client uses is idiosyncratic and identifying; a term k
// unrelated desks independently use is generic. This single count is what keeps a client's
// signature terminology out of the shared plane.
// What the review queue may show a caller. Below k a candidate is one or two desks' own wording,
// and listing it to any signed-in tenant carried it across the wall with a single contributor
// (WP-QA03 S1). Only the admin reviewer sees the whole queue.
export async function visibleCandidates(
  store: { listCandidates(minTenants?: number): Promise<SynonymCandidate[]> },
  isAdmin: boolean,
  k = DEFAULT_K,
): Promise<SynonymCandidate[]> {
  return store.listCandidates(isAdmin ? undefined : k);
}

export function passesAnonymity(candidate: SynonymCandidate, k = DEFAULT_K): boolean {
  return candidate.distinctTenants >= k;
}

export interface TokenVerdict {
  ok: boolean;
  reason?: string;
}

// Company-form / proper-noun tokens that smell proprietary or client-identifying. A label that
// carries any of these is rejected: it is far more likely to be a client, product or entity name
// than a generic financial concept. Exported as a Set so tests can assert against the exact list.
export const IDENTIFYING_TOKENS: Set<string> = new Set([
  "ltd",
  "plc",
  "llp",
  "llc",
  "inc",
  "gmbh",
  "ag",
  "sa",
  "nv",
  "bv",
  "co",
  "group",
  "holdings",
  "partners",
  "capital",
  "ventures",
  "fund",
  "trust",
]);

// Gate 2: the identifying-token filter. Reject a label that is likely client-identifying or
// malformed. We prefer to reject on uncertainty, so the checks are deliberately strict: a
// rejected label can still be taught per-client, it just does not enter the shared plane.
export function passesTokenFilter(labelNorm: string): TokenVerdict {
  const label = labelNorm.trim();

  if (label.length < 3) {
    return { ok: false, reason: "too short (under 3 characters)" };
  }
  if (label.length > 40) {
    return { ok: false, reason: "too long (over 40 characters)" };
  }
  if (/[0-9]/.test(label)) {
    return { ok: false, reason: "contains a digit" };
  }

  const tokens = label.split(/\s+/).filter((t) => t.length > 0);

  if (tokens.length === 1 && tokens[0].length < 3) {
    return { ok: false, reason: "single token under 3 characters" };
  }

  for (const token of tokens) {
    if (IDENTIFYING_TOKENS.has(token)) {
      return { ok: false, reason: `contains identifying token "${token}"` };
    }
  }

  return { ok: true };
}

// Gate 3: base-dictionary conflict. Never promote a mapping that fights the static dictionary,
// and never promote a mapping onto a concept that does not exist. True (conflict) when EITHER:
//   - the static dictionary already maps this labelNorm to a DIFFERENT concept, or
//   - the candidate's conceptKey is not a real engine concept.
// A conflicting or unreal mapping must never reach the shared dictionary.
export function conflictsWithBase(entry: SharedDictionaryEntry): boolean {
  if (conceptForKey(entry.conceptKey) === undefined) return true;
  const base = matchConcept(entry.labelNorm);
  if (base !== null && base.key !== entry.conceptKey) return true;
  return false;
}

export interface PromotionDecision {
  entry: SharedDictionaryEntry;
  promote: boolean;
  reasons: string[]; // every failing gate; empty when promote is true
}

// The policy applied to a batch of candidates, in input order (deterministic). A candidate is
// promoted only when it passes k-anonymity AND the token filter AND does not conflict with the
// base dictionary AND has not already been rejected in review. `reasons` names every gate it
// failed, so the caller can surface exactly why a candidate was held back. Note the human
// sign-off and eval gates still sit outside this pure policy.
export function decideCandidates(candidates: SynonymCandidate[], k = DEFAULT_K): PromotionDecision[] {
  return candidates.map((candidate) => {
    const entry: SharedDictionaryEntry = {
      labelNorm: candidate.labelNorm,
      conceptKey: candidate.conceptKey,
    };
    const reasons: string[] = [];

    if (!passesAnonymity(candidate, k)) {
      reasons.push(`fails k-anonymity (${candidate.distinctTenants} of ${k} distinct tenants)`);
    }
    const token = passesTokenFilter(candidate.labelNorm);
    if (!token.ok) {
      reasons.push(`fails token filter: ${token.reason}`);
    }
    if (conflictsWithBase(entry)) {
      reasons.push("conflicts with the base dictionary");
    }
    if (candidate.status === "rejected") {
      reasons.push("candidate was rejected in review");
    }

    return { entry, promote: reasons.length === 0, reasons };
  });
}
