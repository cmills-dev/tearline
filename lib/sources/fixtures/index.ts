// lib/sources/fixtures/index.ts
// Registry of the bundled illustrative borrowers plus a simple resolver-by-name/number.

import type { BorrowerFixture } from "./types";
import { meridian } from "./meridian";
import { redacta } from "./redacta";

export const FIXTURES: BorrowerFixture[] = [meridian, redacta];

export function listFixtures(): BorrowerFixture[] {
  return FIXTURES;
}

export function getFixtureByKey(key: string): BorrowerFixture | undefined {
  return FIXTURES.find((f) => f.key === key);
}

// Loose lookup used by the entry field: match on key, display name, company name or
// company number, case-insensitively.
export function findFixture(query: string): BorrowerFixture | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  return FIXTURES.find((f) => {
    return (
      f.key === q ||
      f.displayName.toLowerCase().includes(q) ||
      f.profile.company_name.toLowerCase().includes(q) ||
      f.profile.company_number.toLowerCase() === q ||
      (q.includes("meridian") && f.key === "meridian") ||
      (q.includes("redact") && f.key === "redacta")
    );
  });
}

export type { BorrowerFixture } from "./types";
