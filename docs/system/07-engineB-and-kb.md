# 7. Engine B (mandate screen) + the knowledge base

## Engine B - mandate -> ranked names (`lib/engineB/`, `/screen`)

A fund mandate in, a ranked, evidence-backed list of fitting names out.

- **`mandate.ts`** - the typed `MandateSpec`: sectors, regions, size band (turnover|EBITDA), leverage
  band, situation tags (e.g. refinancing, distressed, growth), plus `MANDATE_PRESETS`. This is the same
  spec the conversational onboarding (Engine C) will elicit and extend.
- **`universe.ts`** - the screenable universe (`UniverseMember` with typed `UniverseFact`s carrying
  provenance and `SituationTagFact`s), stamped `UNIVERSE_STAMP` (synthetic/illustrative today; a real
  universe is fed from the KB + sources).
- **`screen.ts`** - `screen(mandate)` scores each member deterministically, every reason pointing at a
  fact, with **hard-filter exclusions shown honestly** (a name that fails a hard criterion is listed as
  excluded with the reason, never silently dropped). Names carry through to their Engine A tear sheet.

Everything is deterministic and provenance-bearing; there is no LLM in the scoring path.

## The knowledge base (`lib/kb/`)

The typed entity-instrument-document-fact graph and the corroboration model that underpins
decision-quality.

- **`graph.ts`** - node kinds `ENTITY | INSTRUMENT | DOCUMENT | FACT` and typed edges (`KbEdge`,
  `KbEdgeRel`). This is the graph the **relationship graph (Engine C)** extends with firm / person /
  deal nodes and advised/financed/sponsored/introduced edges (see
  [08-origination-and-onboarding.md](08-origination-and-onboarding.md)).
- **`check.ts`** - `runEnrichedChecks`, `detectContradictions`, `withinTolerance`: cross-source
  contradiction detection with tolerances.
- **`query.ts`** - the corroboration/independence model: `provenanceTier` (P1..P5) grades a source,
  and `corroborationState` (I0..I5 independence) grades how independently a fact is supported. This is
  what lets the product say "corroborated by two independent sources" honestly, and never claim
  "verified" for one unchecked source.

## How they compose

`sources -> FactManifest` feeds the KB (entities, instruments, facts with provenance tiers). Engine B
screens the universe the KB describes; Engine A renders a single entity; the corroboration model gates
what verification label a fact may carry. Engine C (origination) will add the relationship layer on top
of the same graph.
