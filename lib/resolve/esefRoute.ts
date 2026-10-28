// lib/resolve/esefRoute.ts
// The ESEF hint (audit finding 23). A listed UK plc files tagged ESEF accounts that the
// engine already reads, so a resolved plc should point there instead of the scanned
// Companies House PDF. The LEI comes from the deterministic path: Companies House number to
// the single LEI registered against it (resolveLei with chNumber). No ESEF filing is fetched.

import type { Candidate, EsefHint, ResolveClient } from "./types";

const PUBLIC_TYPES = new Set(["plc", "old-public-company"]);

export function mayFileEsef(c: Pick<Candidate, "type" | "status">): boolean {
  return PUBLIC_TYPES.has(c.type) && c.status !== "dissolved";
}

export async function esefHint(
  c: Pick<Candidate, "number" | "type" | "status">,
  client: ResolveClient
): Promise<EsefHint | undefined> {
  if (!mayFileEsef(c)) return undefined;
  // A GLEIF failure only loses the hint. It never fails the resolution.
  const lei = await client.leiForCompanyNumber(c.number).catch(() => null);
  return lei ? { lei } : undefined;
}
