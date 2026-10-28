// lib/run/fixtureRun.ts
// A run with no CH_API_KEY (dataMode "fixtures"), so the local preview and a fresh checkout can
// drive POST /api/run end to end and the smoke export check has a sheet to export (WP-QA05).
//
// Only the bundled illustrative borrowers (lib/sources/fixtures) can be run this way. The route
// checks fixtureForInput first and answers anything else with the old 503 that names the missing
// key, so fixtures mode never invents a company and never starts a run that can only fail.
// The sheet it saves is the fixture's own manifest, which is stamped synthetic, so every screen
// and export that shows it says "Illustrative".
//
// Nothing here touches the network or a model.

import { findFixture, listFixtures, type BorrowerFixture } from "../sources/fixtures";
import { manifestForKey } from "../engine/pipeline";
import type { FactManifest } from "../engine/types";
import type { ChProfile, ChSearchResult, ResolveClient } from "../resolve/types";
import { MANIFEST_STAGES, type StageCallback } from "../vision/types";

function byNumber(n: string): BorrowerFixture | undefined {
  const q = n.trim().toUpperCase();
  return listFixtures().find((f) => f.profile.company_number.toUpperCase() === q);
}

// The bundled borrower a typed input names, by number or by the entry field's loose name match.
export function fixtureForInput(input: string): BorrowerFixture | undefined {
  return byNumber(input) ?? findFixture(input);
}

// The register, as far as the bundled fixtures go. Search matches the same loose rules the entry
// field uses (lib/sources/fixtures findFixture). No fixture files real filings or has an LEI.
export class FixtureRegisterClient implements ResolveClient {
  async search(q: string): Promise<ChSearchResult> {
    const f = findFixture(q);
    if (!f) return { items: [], total_results: 0 };
    const p = f.profile;
    return {
      items: [
        {
          company_number: p.company_number,
          title: p.company_name,
          company_status: p.company_status,
          company_type: p.type,
          date_of_creation: p.date_of_creation,
        },
      ],
      total_results: 1,
    };
  }

  async profile(number: string): Promise<ChProfile | null> {
    const f = byNumber(number);
    return f ? (f.profile as ChProfile) : null;
  }

  async filingHistory(): Promise<[]> {
    return [];
  }

  async leiForCompanyNumber(): Promise<string | null> {
    return null;
  }
}

// The builder in fixtures mode: the fixture's manifest, with one plain line per stage so the
// progress display reads the same as a live run's.
export async function buildFixtureManifest(
  number: string,
  options: { onStage?: StageCallback } = {},
): Promise<FactManifest> {
  const f = byNumber(number);
  const manifest = f ? manifestForKey(f.key) : null;
  if (!f || !manifest) {
    throw new Error(`No bundled fixture for ${number}. Set CH_API_KEY to run a real company.`);
  }
  const say = (stage: (typeof MANIFEST_STAGES)[number], status: "done" | "skipped", detail: string) => {
    try {
      options.onStage?.({ stage, status, detail, at: new Date().toISOString() });
    } catch {
      /* a progress display must not fail a run */
    }
  };
  say("resolve", "done", `${f.displayName}: bundled illustrative filing, no register call (fixtures mode)`);
  say("fetch", "skipped", "Fixtures mode: the filing is bundled with the app");
  say("extract", "skipped", "Fixtures mode: the figures are bundled, no model is called");
  say("verify", "skipped", "Fixtures mode: no second read");
  say("assemble", "done", `${Object.keys(manifest.facts).length} illustrative facts assembled`);
  return manifest;
}
