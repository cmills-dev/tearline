// lib/clientspec/sharedHash.ts
// The one-way, KEYED hash of a tenant id used by the shared plane. Kept in its own module so the
// in-memory and Postgres shared stores share ONE implementation without a circular import. A
// keyed HMAC (not a bare sha256) is required: tenant ids are low-cardinality and enumerable, so a
// plain digest could be reversed by precomputing hashes for every known desk. The server-held
// pepper makes that infeasible, which is what lets the shared plane count DISTINCT tenants
// without ever learning which tenant used which term. Set SHARED_HASH_PEPPER (or AUTH_SECRET) in
// production; the dev fallback is only for the keyless local demo, where the plane is in-memory.

import { createHmac } from "crypto";

function hashPepper(): string {
  return process.env.SHARED_HASH_PEPPER || process.env.AUTH_SECRET || "dev-shared-pepper";
}

export function hashTenantId(tenantId: string): string {
  return createHmac("sha256", hashPepper()).update(tenantId).digest("hex");
}
