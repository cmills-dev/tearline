// lib/onboarding/mandate.ts
// The tenant's stored origination mandate (captured in the setup wizard's desk step). Origination
// routes read this as the default when a request does not carry an explicit mandate, so a desk's
// stated sectors / size band / leverage ceiling actually drive fit-scoring instead of being lost.

import { getClientSpecStore } from "../clientspec/store";
import type { MandateLike } from "../originate/signals";

// The tenant's saved mandate as a MandateLike (the shapes are field-compatible: turnover bounds are
// stored in absolute currency). Returns an empty mandate when the tenant has saved none, so a
// caller can always spread it safely.
export async function getTenantMandate(tenantId: string): Promise<MandateLike> {
  if (!tenantId) return {};
  const state = await getClientSpecStore().getState(tenantId);
  return state.mandate ?? {};
}
