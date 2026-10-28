# 8. Origination (Engine C), the relationship graph, and conversational setup

Status: **core built and tested** (in-memory, no key). Persistence (Postgres graph store) and the
real key-gated ingesters beyond charges are the remaining flip-steps.

## The USP this builds toward

**The only origination layer that fuses a document-cited credit catalyst (why-now) with the firm's
own relationship graph (why-you), runs inside their existing data licences (BYO), and shows its work
on every claim.** No incumbent sits at that intersection: research/credit tools read the filing but
not your network; relationship-intelligence tools own the network but do not read filings to
filing-grade. The honest-citation trust layer is the substrate that makes both believable, not the
headline. The conversational onboarding is the per-tenant compounding data loop that turns it into a
moat over time. See `docs/usp.md`.

## What is built (`lib/graph/`, `lib/originate/`, `lib/onboarding/`)

- **Relationship graph** (`lib/graph/model.ts`, `store.ts`, `path.ts`): typed nodes
  (company/person/firm/deal) and provenanced edges (advised/financed/sponsored/knows/introduced_by/…),
  tenant-scoped, with `warmestPaths` - an inverse-trust weighted finder that **abstains (null) when no
  path clears the confidence floor**. A provenance-less edge is refused at the store.
- **Signals** (`lib/originate/signals.ts`): the "why now" catalyst + fit signals computed from the
  FactManifest, each carrying the exact provenance of the fact it derives from; an uncited signal goes
  to `abstentions`, never `whyNow`.
- **Engine C** (`lib/originate/engine.ts`, `score.ts`, `suggestion.ts`): joins signals + warm path
  into a ranked `OriginationSuggestion`. Hard gate: surfaced only with a cited catalyst; a strong
  catalyst with no path is "cold", never linked by a guess. Transparent, decomposable scoring (fit is
  a multiplier so off-thesis never ranks; a path gate demotes cold targets).
- **Filing ingesters** (`lib/graph/ingest/`): real Companies House data → provenanced edges -
  `chCharges` (charges → `financed`, the lender is named), `chOfficers` (directors → `officer_of`,
  a shared director bridges two companies), `chPsc` (owners → `owns`, a corporate PSC is the
  sponsor), and `companiesHouse.ingestCompanyNetwork` (one call: charges + officers + PSC + GLEIF
  ultimate parent). Validated live on Greggs: 25 lenders, 35 directors, 60 provenanced edges.
- **Entity resolution** (`lib/graph/resolve.ts`): resolves a name-only node to its canonical LEI
  via GLEIF only on a confident match, else leaves it "unresolved" in a review band - **abstains
  rather than mis-links** (the highest-leverage correctness step). Onboarded and filing-derived
  nodes share the `firm:`/`co:` id scheme, so a counterparty the client knows and the same
  counterparty named on a target's filing are ONE node - which is what lets a warm path connect them.
- **Live Engine C** (`lib/originate/live.ts`, `POST /api/originate`): for a real target CH number,
  ingests its network, builds its manifest, computes the cited catalyst, and finds the warmest path
  from the client firm - the moment the firm's onboarded graph meets the target's filed graph. It
  abstains honestly when there is no cited catalyst (e.g. Greggs, which has satisfied its charges).
- **Charges ingester** (`lib/graph/ingest/chCharges.ts`): real Companies House charges → `financed`
  edges (the lender is named on the charge), with the charge text as provenance.
- **Conversational onboarding** (`lib/onboarding/`): a deterministic slot-filling flow
  (`machine.ts`) with an LLM (or no-key heuristic) extractor (`agent.ts`) that parses answers into
  typed slots, confirms each, and **seeds the graph** with the firm's stated relationships as
  tenant-private, "stated by the client" edges (`tools.ts`). Nothing is invented from an empty answer.
- **UI**: `/onboarding` (conversational chat) and `/originate` (ranked suggestions with clickable
  why-now evidence and every warm-path hop), plus `POST /api/onboarding`.

Tests: `test/graph.test.ts`, `test/originate.test.ts`, `test/onboarding.test.ts`.

The design is synthesised from the origination-expansion research pass (USP, origination engine,
relationship graph, conversational onboarding).

## Engine C - origination of work

Finds NEW work for a client firm from *their* network plus deterministic timing/fit signals. Every
suggestion is evidence-backed with a real relationship path shown - never an invented connection.
Inputs: the firm's `MandateSpec` + `RelationshipSpec` (below) and the relationship graph. Output: an
`OriginationSuggestion` (target company, why-now signal, fit to mandate, and the warm-intro path).

Deterministic signals: refinancing / maturity windows (from debt facilities and CH charges), distress
triggers, ownership/sponsor change, sector/size fit, and warm-intro proximity (the firm already knows
an adviser / lender / sponsor connected to the target).

## The relationship graph

Extends the KB graph (`lib/kb/graph.ts`) with node kinds `FIRM` (PE / law / lender / adviser),
`PERSON`, `DEAL`, and edges `ADVISED / FINANCED / SPONSORED / WORKS_AT / PORTFOLIO_OF / INTRODUCED_BY`.
Built from public/entitled sources with provenance + confidence on **every edge** (no fabricated
relationships): Companies House charges (reveal lenders, often the law firm), GLEIF parent/subsidiary,
filing officers/PSCs, RNS/press deal announcements, and the client's own CRM export. Warm-intro
path-finding = shortest trusted path from the client firm to a target.

## Conversational setup / onboarding

A grounded, resumable, question-asking agent (on the model-agnostic layer + tool-use) that onboards a
firm: it elicits and confirms the `MandateSpec`, the `RelationshipSpec` (which sponsors / law firms /
lenders / advisers / portfolio companies they know, and how well), and the house-style `ClientSpec`,
writes them to the tenant store, and seeds the relationship graph. It never fabricates a relationship -
each captured fact is confirmed with the user and stored with provenance "stated by the client".

## Key new schemas (to be added)

`RelationshipSpec`, `OriginationSuggestion`, the relationship graph node/edge extensions, and the
onboarding conversation state schema. See the code under `lib/origination/`, `lib/graph/`, and
`lib/onboarding/` as they are built, and their tests + eval cases.
