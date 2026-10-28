// lib/monitor/diff.ts
// The pure heart of the engine: diffSnapshots(prev, next) -> the cited changes between two
// snapshots. No network, no clock, no store; given the same two snapshots it always returns
// the same events, so it is fully unit-testable. Every event it emits carries a provenance
// naming the exact CH field that moved, so nothing here can produce an uncited "what
// changed" line. When nothing moved it returns an empty array.

import type { ChangeEvent, ChangeKind, EventProvenance, Snapshot } from "./types";
import { publicRecordUrl } from "./types";

// Register labels used in citations, so a rendered event says which public register it came
// from rather than a generic "Companies House".
const REGISTER = {
  charges: "Companies House charges register",
  psc: "Companies House persons-with-significant-control register",
  officers: "Companies House officers register",
  profile: "Companies House public register (structured record)",
} as const;

// Build one cited event. `next` supplies the tenant, company, timing and locator so the
// caller never has to assemble provenance by hand; an event is therefore never constructed
// without a source. `field` is the exact CH field or filing that moved.
function event(
  next: Snapshot,
  kind: ChangeKind,
  detail: string,
  source: string,
  field: string,
): ChangeEvent {
  const provenance: EventProvenance = {
    source,
    field,
    retrievedAt: next.takenAt,
    locator: publicRecordUrl(next.chNumber),
  };
  return {
    tenantId: next.tenantId,
    chNumber: next.chNumber,
    kind,
    detail,
    provenance,
    observedAt: next.takenAt,
  };
}

export function diffSnapshots(prev: Snapshot, next: Snapshot): ChangeEvent[] {
  const events: ChangeEvent[] = [];

  // --- Charges: newly registered, satisfied, otherwise status-changed, or removed ----------
  const prevCharges = new Map(prev.charges.map((c) => [c.id, c.status]));
  const nextCharges = new Map(next.charges.map((c) => [c.id, c.status]));
  for (const [id, status] of nextCharges) {
    const before = prevCharges.get(id);
    if (before === undefined) {
      events.push(
        event(
          next,
          "charge-registered",
          `New charge ${id} registered (status ${status}).`,
          REGISTER.charges,
          `charges[${id}].status`,
        ),
      );
    } else if (before !== status) {
      if (before !== "satisfied" && status === "satisfied") {
        events.push(
          event(
            next,
            "charge-satisfied",
            `Charge ${id} newly satisfied (was ${before}).`,
            REGISTER.charges,
            `charges[${id}].status`,
          ),
        );
      } else if (before && status) {
        // Any other status movement between two KNOWN statuses, e.g. outstanding ->
        // part-satisfied. Guarded on both sides being non-empty so a data gap (a status that
        // went blank because a fetch could not read it) never renders as a register movement.
        events.push(
          event(
            next,
            "charge-status-changed",
            `Charge ${id} status changed from ${before} to ${status}.`,
            REGISTER.charges,
            `charges[${id}].status`,
          ),
        );
      }
    }
  }
  // A charge that was on the register and is no longer present (a correction, or the charge
  // record withdrawn). Cited to the same register; only emitted when the prior status was known.
  for (const [id, before] of prevCharges) {
    if (!nextCharges.has(id) && before) {
      events.push(
        event(
          next,
          "charge-removed",
          `Charge ${id} no longer on the register (was ${before}).`,
          REGISTER.charges,
          `charges[${id}].status`,
        ),
      );
    }
  }

  // --- PSC: added and removed ----------------------------------------------
  diffIdSet(
    prev.pscIds,
    next.pscIds,
    (id) =>
      events.push(
        event(next, "psc-added", `New person with significant control: ${id}.`, REGISTER.psc, "persons-with-significant-control"),
      ),
    (id) =>
      events.push(
        event(next, "psc-removed", `Person with significant control ceased: ${id}.`, REGISTER.psc, "persons-with-significant-control"),
      ),
  );

  // --- Officers: appointed and removed (register movement, cited the same way) ---
  diffIdSet(
    prev.officerIds,
    next.officerIds,
    (id) =>
      events.push(
        event(next, "officer-appointed", `New officer appointment: ${id}.`, REGISTER.officers, "officers"),
      ),
    (id) =>
      events.push(
        event(next, "officer-removed", `Officer appointment ceased: ${id}.`, REGISTER.officers, "officers"),
      ),
  );

  // --- Company status change -----------------------------------------------
  if (
    prev.companyStatus !== null &&
    next.companyStatus !== null &&
    prev.companyStatus !== next.companyStatus
  ) {
    events.push(
      event(
        next,
        "status-changed",
        `Company status changed from ${prev.companyStatus} to ${next.companyStatus}.`,
        REGISTER.profile,
        "company_status",
      ),
    );
  }

  // --- Accounts newly overdue ----------------------------------------------
  if (!prev.accountsOverdue && next.accountsOverdue) {
    events.push(
      event(
        next,
        "accounts-overdue",
        "Annual accounts are now overdue.",
        REGISTER.profile,
        "accounts.next_accounts.overdue",
      ),
    );
  }

  // --- Confirmation statement newly overdue --------------------------------
  if (!prev.confirmationOverdue && next.confirmationOverdue) {
    events.push(
      event(
        next,
        "confirmation-overdue",
        "Confirmation statement is now overdue.",
        REGISTER.profile,
        "confirmation_statement.overdue",
      ),
    );
  }

  // Defensive honesty guard: never emit an event that lost its citation.
  return events.filter((e) => e.provenance && e.provenance.field && e.provenance.source);
}

// Set difference over two id lists: call onAdded for ids only in next, onRemoved for ids
// only in prev. Duplicate ids collapse to one, which is what we want for identity sets.
function diffIdSet(
  prevIds: string[],
  nextIds: string[],
  onAdded: (id: string) => void,
  onRemoved: (id: string) => void,
): void {
  const prevSet = new Set(prevIds);
  const nextSet = new Set(nextIds);
  for (const id of nextSet) if (!prevSet.has(id)) onAdded(id);
  for (const id of prevSet) if (!nextSet.has(id)) onRemoved(id);
}
