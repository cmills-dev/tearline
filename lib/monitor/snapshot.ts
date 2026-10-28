// lib/monitor/snapshot.ts
// buildSnapshot(chNumber) captures the compared public state of one company by REUSING the
// existing Companies House live fetchers (getProfile, getCharges, getPsc, getOfficers).
// Those fetchers are cached and each hop already passes through the global CH budget guard
// (assertChBudget), so monitoring respects CH's 600-per-5-minutes ceiling for free. This
// module reads only; it never writes to the register and never invents a field.

import { getProfile, getCharges, getPsc, getOfficers } from "../sources/companiesHouseLive";
import type { CompanyProfile } from "../sources/companiesHouse";
import type { Snapshot, ChargeState } from "./types";

// The confirmation_statement block is not on the CompanyProfile type the connector exports,
// but the live API returns it. Read it through this narrow extension rather than casting to
// any, so a missing block reads as "not overdue" instead of throwing.
interface ProfileExtras {
  confirmation_statement?: { overdue?: boolean };
}

// A stable identity for a person with significant control. The PSC feed carries no id, so
// we key on name plus the date first notified, which is stable across re-checks and unique
// enough to tell two same-named notifications apart.
function pscIdentity(p: { name?: string; notified_on?: string }): string {
  return `${(p.name ?? "unknown").trim()}${p.notified_on ? ` (notified ${p.notified_on})` : ""}`;
}

// A stable identity for an officer appointment: name, role and appointment date. Two roles
// held by one person are two appointments, so the role is part of the key.
function officerIdentity(o: { name?: string; officer_role?: string; appointed_on?: string }): string {
  const role = o.officer_role ? ` [${o.officer_role}]` : "";
  return `${(o.name ?? "unknown").trim()}${role}${o.appointed_on ? ` (appointed ${o.appointed_on})` : ""}`;
}

export async function buildSnapshot(chNumber: string, tenantId = ""): Promise<Snapshot> {
  // Fetch the four register faces in parallel. Each is independently cached and budget-
  // guarded; a 404 on charges/PSC/officers already resolves to an empty answer upstream.
  const [profile, charges, psc, officers] = await Promise.all([
    getProfile(chNumber),
    getCharges(chNumber),
    getPsc(chNumber),
    getOfficers(chNumber),
  ]);

  const p = profile as CompanyProfile & ProfileExtras;

  const chargeStates: ChargeState[] = (charges.items ?? []).map((c) => ({
    id: String(c.charge_number),
    status: c.status,
  }));

  // Only ACTIVE holders are compared, so a PSC or officer gaining a ceased/resigned date
  // drops out of the set and reads as a removal, whether the register keeps the ceased row
  // or drops it entirely.
  const pscIds = (psc.items ?? [])
    .filter((x) => !x.ceased_on)
    .map(pscIdentity);
  const officerIds = (officers.items ?? [])
    .filter((x) => !x.resigned_on)
    .map(officerIdentity);

  const accountsOverdue = Boolean(
    profile.accounts?.next_accounts?.overdue ?? profile.accounts?.overdue ?? false,
  );
  const confirmationOverdue = Boolean(p.confirmation_statement?.overdue ?? false);

  return {
    tenantId,
    chNumber,
    takenAt: new Date().toISOString(),
    companyStatus: profile.company_status ?? null,
    charges: chargeStates,
    pscIds,
    officerIds,
    accountsOverdue,
    confirmationOverdue,
  };
}
