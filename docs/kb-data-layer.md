# Module 2 data layer: the durable entity-instrument-document graph (increment 1)

Built the first increment of the plan's Module 2 (the compounding data asset): the master-ID
entity spine and cross-source fact accumulation. See `docs/engine-modular-plan.md` for the full
Module 2 scope. This layer sits above the per-manifest `lib/kb/graph.ts` (TenantGraph): where that
decomposes one tear sheet in memory, this RESOLVES the same real-world company seen through
different sources (Companies House number, SEC CIK, GLEIF LEI) to ONE master entity and
ACCUMULATES its facts across sources and filings.

## What is built

- **Master-ID spine + resolver** (`lib/kb/masterId.ts`): strongest-identifier ids
  (`lei:` > `ch:` > `cik:` > `name:`), join only on LEI / CH / CIK (never on name), the LEI is
  authoritative when both sides carry one, CIK zero-padding normalised.
- **Durable KB store** (`lib/kb/kbStore.ts` + `kbPostgres.ts`, migration `0009_kb.sql`): the
  GLOBAL shared Tier-0 plane (public facts are shared, so no tenant scoping, no RLS, mirroring the
  shared-learning store). Entity resolve-and-merge, document accumulation, and fact upsert with
  amendment precedence.
- **Corroboration vs amendment** (the key semantic): the fact lane is
  `(masterId, metric, period, SOURCE)`. A source amending its own earlier filing (newer asOf)
  supersedes it; DISTINCT sources reporting the same metric/period both stay live and coverage
  names both. This matches the independence doctrine in `lib/kb/check.ts`.
- **Ingest** (`lib/kb/ingest.ts`): manifest + source in, master entity + accumulated facts out;
  never mutates a value; fenced to Tier-0 public sources so nothing entitled or client-supplied
  reaches the shared plane.
- **Coverage query + browser** (`/api/kb/*`, `/kb`): per entity, which sources hold each
  metric/period, the freshest asOf and the rung.

Verified end to end: ingesting Meridian via `companies-house` and again via `esef` (same LEI)
resolves to ONE master entity whose coverage shows every metric corroborated by both sources
(`sourceCount: 2`). Tests: `test/kb-masterid.test.ts` (13), `test/kb-store.test.ts` (6),
`test/kb-ingest.test.ts` (3). Full suite 404 passing.

## Adversarial review outcome

A review ran alongside the build. Fixed: the two-source coverage lane (per-source), the LEI
conflict guard (different LEIs never fuse on a weaker shared key), CIK zero-padding, the Postgres
survivor `order by`, and the ingest public-source fence.

Deferred (tracked, not yet fixed):
- **asOf for annual restatements.** `asOfForFact` derives asOf from the period year end, so a
  source restating the SAME period gets an equal asOf and does not supersede its original. The fix
  is to drive precedence from the filing/as-reported date, not the period end; it needs the
  filing-date threaded through ingest and the ingest precedence test updated. Medium.
- **Merge lane reconciliation.** When two entities merge and BOTH held a live fact for the same
  `(metric, period, source)`, `absorb` re-points without reconciling, so two live facts can coexist
  in one lane. Rare now that lanes are per-source (needs the same source across two pre-merge
  entities), but it violates the one-live-per-lane invariant and should reconcile on merge. Medium.
- **Scale.** The in-memory store keeps all facts in one array scanned linearly; fine for the demo,
  needs indexing for a real global plane. Low.

## Increment 2: instruments, known-unknowns, and the provenance envelope (#2, #3, #4 BUILT)

- **Instruments (#2)** (`kbStore`/`kbPostgres` `upsertInstrument`/`listInstruments`, migration
  `0010`, ingest wiring): a tranche/charge fact metric now also accumulates a `KbInstrument` on the
  entity, per source, so the capital structure compounds and corroborates across sources. Verified
  live: the merged Meridian entity carries 4 instruments, each tranche seen from both
  `companies-house` and `esef`.
- **Known-unknowns / coverage-gap API (#3)** (`lib/kb/knownUnknowns.ts`): per concept, supported
  (a live fact is held, with its sources and rung) or a GAP with a reason and what closes it. The
  filleted-accounts case is modelled (no P&L, needs full accounts or an entitled source). Verified:
  the Meridian entity reports 11 supported / 3 gaps honestly.
- **Provenance envelope + export policy (#4)** (`Provenance` gains optional `asOf` / `entitlement`
  / `tier` / `confidence`; `lib/kb/exportPolicy.ts`): the export-policy engine reads the entitlement
  tag and FAILS CLOSED, public flows freely, entitled needs the licence, client stays in its owning
  tenant. The contract change is additive; the extraction eval stays 100% / 0.

Exposed at `/kb` and `/api/kb/entity` (coverage + instruments + known-unknowns).

### Review outcome (increment 2)
Confirmed clean: export fail-closed, known-unknowns honesty (support only when a live fact is
held), instrument ingest (no invented instrument, value untouched, tag never dropped). One MEDIUM
fixed: a bridge-merge re-pointing documents/instruments (natural composite keys) could collide
(Postgres unique violation, in-memory duplicate); both stores now drop the colliding loser row and
re-point the rest, guarded by a new regression test.

## Next in Module 2

1. Fix the two deferred increment-1 correctness items (restatement as-of, fact-lane merge reconcile).
2. Thread the entity `accountsType` into `knownUnknowns` so the filleted-accounts reason shows in
   the API/UI (works in unit tests today; the route passes no accountsType yet, so gaps read generic).
3. The source-specialist plug-in framework so a new source (Gazette, GLEIF, LSE) is a plug-in that
   emits the envelope.
4. The ontology proper: grow the flat concept dictionary into a catalogue (units, derivation
   relationships) that ClientSpec and the fact engine bind to.
