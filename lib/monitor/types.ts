// lib/monitor/types.ts
// The two records the change-detection engine turns on: a Snapshot (the compared public
// state of a company at a moment) and a ChangeEvent (a single cited diff between two
// snapshots). The honesty rule is carried in the type: every ChangeEvent MUST hold a
// provenance naming the source and the exact CH field or filing that moved. An event with
// no observed source is never constructed, so a rendered "what changed" line always traces
// back to the public register, never to an inference of ours.

// The state of one registered charge we compare across snapshots. `id` is the CH
// charge_number rendered as a string; `status` is the register's own status word
// ("outstanding", "satisfied", ...).
export interface ChargeState {
  id: string;
  status: string;
}

// The compared public state of a company at `takenAt`. Deliberately minimal: only the
// fields a desk cares to be alerted on, each read straight from the Companies House
// structured record. Snapshots are the diff inputs, so this shape is the contract the
// pure differ depends on.
export interface Snapshot {
  tenantId: string;
  chNumber: string;
  takenAt: string; // ISO timestamp the snapshot was captured
  companyStatus: string | null; // profile.company_status
  charges: ChargeState[]; // charge_number + status, one per registered charge
  pscIds: string[]; // identity of each ACTIVE person with significant control
  officerIds: string[]; // identity of each ACTIVE officer (appointment)
  accountsOverdue: boolean; // accounts.next_accounts.overdue (fallback accounts.overdue)
  confirmationOverdue: boolean; // confirmation_statement.overdue
}

// The kinds of change the differ detects. Each maps to exactly one register movement.
export type ChangeKind =
  | "charge-registered"
  | "charge-satisfied"
  | "charge-status-changed"
  | "charge-removed"
  | "psc-added"
  | "psc-removed"
  | "officer-appointed"
  | "officer-removed"
  | "status-changed"
  | "accounts-overdue"
  | "confirmation-overdue";

// The citation every event must carry. `source` is the human-readable register, `field`
// is the exact CH field or filing that moved, `retrievedAt` is when the fresh snapshot was
// captured, `locator` is the public record URL a reader can open.
export interface EventProvenance {
  source: string;
  field: string;
  retrievedAt: string; // ISO
  locator: string;
}

// A single cited change. `detail` is the analyst-voice one-liner; `provenance` is
// mandatory (see the module note). `observedAt` is the moment the diff was taken, which is
// the fresh snapshot's takenAt, so the record is deterministic and testable with no clock.
export interface ChangeEvent {
  tenantId: string;
  chNumber: string;
  kind: ChangeKind;
  detail: string;
  provenance: EventProvenance;
  observedAt: string; // ISO
  // Identifies the movement, not the check that saw it: the baseline snapshot's takenAt plus the
  // kind, field and detail. Two concurrent checks diffing the same baseline produce the same key,
  // and a store records a key once per tenant (WP-QA05). Absent on events built outside runCheck.
  key?: string;
}

// The human-readable public record every event points at. Kept here (not imported from the
// live connector) so the differ stays a pure, network-free, cheaply-testable module.
export function publicRecordUrl(chNumber: string): string {
  return `https://find-and-update.company-information.service.gov.uk/company/${encodeURIComponent(
    chNumber,
  )}`;
}
