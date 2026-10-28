// lib/engine/pipeline.ts
// End-to-end entry: a fixture key (or query) in, a fully assembled, ProseGate-clean
// TearSheet out. This is the seam the live Companies House connector plugs into: when
// CH_API_KEY is set, a live-fetch branch would populate the same FactManifest shape
// before assembly. Everything downstream is source-agnostic.

import { assembleTearSheet, TearSheet } from "./assemble";
import { buildManifest } from "./buildManifest";
import type { FactManifest } from "./types";
import { findFixture, getFixtureByKey, listFixtures } from "../sources/fixtures";
import { isLiveModeEnabled } from "../sources/companiesHouse";
import { getProvider } from "../llm/config";
import { extractFactsFromDocument, toFactDrafts } from "../llm/extract";

export function dataMode(): "live" | "fixtures" {
  return isLiveModeEnabled() ? "live" : "fixtures";
}

// Whether a pluggable parsing model is configured (LLM_PROVIDER/LLM_MODEL/...).
// The parsing engine is model-agnostic: any Claude model, any OpenAI-compatible
// endpoint, or a local model, selected purely by environment configuration.
export function llmMode(): "on" | "off" {
  return getProvider() ? "on" : "off";
}

// Parse a raw accounts document into anchored candidate facts using whatever model
// is configured. Returns [] when no model is configured or no document is supplied,
// so the deterministic fixture/structured path is never affected. The model may only
// propose a figure that it quotes verbatim from the document; lib/llm/extract drops
// any figure whose quote is not present in the source, so fabrication has no path in.
export async function extractDocumentFacts(documentText: string, metrics: string[]) {
  const provider = getProvider();
  if (!provider || !documentText) return [];
  const extractions = await extractFactsFromDocument(documentText, { metrics, provider });
  return toFactDrafts(extractions, "Acc");
}

export function tearSheetForKey(key: string): TearSheet | null {
  const fixture = getFixtureByKey(key);
  if (!fixture) return null;
  return assembleTearSheet(buildManifest(fixture), fixture);
}

// The FactManifest for a key (the persistable unit: facts + provenance, before the
// document is assembled). This is what the tenant store saves and reads back.
export function manifestForKey(key: string): FactManifest | null {
  const fixture = getFixtureByKey(key);
  return fixture ? buildManifest(fixture) : null;
}

// Assemble a tear sheet from a manifest that was read back from the store, pairing
// it with the key's static fixture scaffolding. Lets a saved record render without
// regenerating its facts, so persistence is a real load path, not just a mirror.
export function assembleFromManifest(key: string, manifest: FactManifest): TearSheet | null {
  const fixture = getFixtureByKey(key);
  return fixture ? assembleTearSheet(manifest, fixture) : null;
}

export function tearSheetForQuery(query: string): TearSheet | null {
  const fixture = findFixture(query);
  if (!fixture) return null;
  return assembleTearSheet(buildManifest(fixture), fixture);
}

export function demoIndex() {
  return listFixtures().map((f) => ({
    key: f.key,
    displayName: f.displayName,
    thesis: f.thesis,
    companyNumber: f.profile.company_number,
    accountsType: f.profile.accounts?.last_accounts?.type ?? "",
  }));
}

export type { TearSheet } from "./assemble";
