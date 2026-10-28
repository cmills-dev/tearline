// lib/kb/exportPolicy.ts
// Module 2 (#4): the export-policy engine. This is the payoff of the frozen provenance envelope:
// the entitlement tag decided at ingest is the thing the export layer enforces here. Given a
// fact's provenance envelope (or an explicit entitlement tag on an item), decide whether the fact
// may be exported or whether it must stay inside its owning tenant's silo.
//
// DOCTRINE: default to LEAST exposure. A public Tier-0 fact flows freely; an entitled fact never
// leaves without the licence; a client-supplied fact never leaves its owning tenant. Anything not
// clearly public is gated. These are PURE, deterministic functions: no I/O, no store, no network.

import type { Provenance } from "../engine/types";

export type Entitlement = "public" | "entitled" | "client";

// The safe default is "public": a fact with no envelope is a public-plane Tier-0 fact.
export function entitlementOf(provenance: Provenance | null | undefined): Entitlement {
  return provenance?.entitlement ?? "public";
}

// Who is exporting, which tenant owns the silo the fact came from, and (for an entitled fact)
// whether the exporting tenant actually holds the entitlement / licence.
export interface ExportContext {
  tenantId: string;
  ownerTenantId?: string;
  hasEntitlement?: boolean;
}

export interface ExportVerdict {
  allowed: boolean;
  reason: string;
}

// The single gate. Given an entitlement plane and the exporting context, decide.
export function canExport(entitlement: Entitlement, ctx: ExportContext): ExportVerdict {
  switch (entitlement) {
    case "public":
      // Tier-0 shared data. Always exportable.
      return { allowed: true, reason: "public Tier-0 data" };

    case "entitled":
      // An entitled fact never leaves without the licence.
      if (ctx.hasEntitlement === true) {
        return { allowed: true, reason: "entitled data, licence held by the exporting tenant" };
      }
      return {
        allowed: false,
        reason: "entitled data blocked: the exporting tenant does not hold the required entitlement",
      };

    case "client":
      // A client-supplied fact stays in its owning tenant's silo.
      if (ctx.ownerTenantId !== undefined && ctx.tenantId === ctx.ownerTenantId) {
        return { allowed: true, reason: "client-supplied data exported within its owning tenant" };
      }
      return {
        allowed: false,
        reason: "client-supplied data cannot leave its owning tenant",
      };

    default:
      // Unreachable for well-typed input, but least-exposure by default: block the unknown.
      return {
        allowed: false,
        reason: "unknown entitlement blocked by default to least exposure",
      };
  }
}

// Classify a mixed list of items into what may be exported and what is blocked (with the reason).
// Prefer an explicit `entitlement` field on the item, else derive it from the item's provenance
// envelope (which itself defaults to public when the envelope is absent).
export function partitionExportable<
  T extends { provenance?: Provenance | null; entitlement?: Entitlement }
>(items: T[], ctx: ExportContext): { exportable: T[]; blocked: { item: T; reason: string }[] } {
  const exportable: T[] = [];
  const blocked: { item: T; reason: string }[] = [];

  for (const item of items) {
    const entitlement = item.entitlement ?? entitlementOf(item.provenance);
    const verdict = canExport(entitlement, ctx);
    if (verdict.allowed) {
      exportable.push(item);
    } else {
      blocked.push({ item, reason: verdict.reason });
    }
  }

  return { exportable, blocked };
}
