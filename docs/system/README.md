# System documentation

This directory documents each section of the origination engine (the `product/` app). It is the
map for a new engineer. The governing principle throughout is the **no-fabrication rule**: every
figure a user sees is traceable to a source, and the system abstains rather than guesses. Read
[docs/extraction-strategy.md](../extraction-strategy.md) for the data-sourcing strategy that frames
all of this.

## What the product is

A credit + origination intelligence platform for PE / private-credit / restructuring / advisory
desks. Two engines today, a third (origination) in build:

- **Engine A** - a company name or a partner's tip in, a fully-cited tear sheet out (financials,
  capital structure, verification, resolution ladder), in the desk's house style.
- **Engine B** - a fund mandate in, a ranked, evidence-backed list of fitting names out.
- **Engine C (in build)** - origination of work: new deals for the firm found from *their* network
  (who they know: sponsors, lenders, law firms, advisers) plus deterministic timing/fit signals.

Commercial thesis: **BYO-entitlement** - we run inside the client's own data licences and are the
intelligence layer, not a data reseller.

## The pipeline in one line

`source -> FactManifest (typed facts + provenance) -> resolution ladder -> verification gate ->
assemble -> tear sheet (EvidenceCards + prosegate-clean prose)`

Every source (SEC, Companies House, ESEF, fixtures) maps into one **FactManifest**, so everything
downstream is source-agnostic.

## Section index

| # | Section | Doc | Code |
|---|---------|-----|------|
| 1 | Engine core (ladder, ProseGate, language plane, FactManifest, EvidenceCards) | [01-engine-core.md](01-engine-core.md) | `lib/engine/` |
| 2 | Data sources (SEC, CH, iXBRL, PDF, ESEF, GLEIF) | [02-sources.md](02-sources.md) | `lib/sources/` |
| 3 | Extraction guards + verification (no-fabrication) | [03-guards-and-verification.md](03-guards-and-verification.md) | `lib/engine/verify.ts`, `lib/llm/extract.ts`, `lib/ocr/` |
| 4 | Persistence, tenancy, auth, the MNPI wall | [04-persistence-and-auth.md](04-persistence-and-auth.md) | `lib/store/`, `lib/tenant.ts`, `lib/auth/`, `db/migrations/` |
| 5 | App + routes | [05-app-and-routes.md](05-app-and-routes.md) | `app/` |
| 6 | Testing + the eval gates | [06-testing-and-eval.md](06-testing-and-eval.md) | `test/`, `eval/` |
| 7 | Engine B (mandate screen) + the knowledge base | [07-engineB-and-kb.md](07-engineB-and-kb.md) | `lib/engineB/`, `lib/kb/` |
| 8 | Origination (Engine C), relationship graph, conversational setup | [08-origination-and-onboarding.md](08-origination-and-onboarding.md) | (in build) |

## Running it

```
cd product
npm install
npm run dev        # http://localhost:3000
npm test           # unit tests (deterministic, no network)
npm run eval       # extraction eval gates (100% precision on surfaced figures)
npm run build      # production build
```

Environment (all optional; the demo runs with none) - see `.env.example`:

- `CH_API_KEY` - real UK Companies House data (free key).
- `DATABASE_URL` - durable Postgres persistence + the enforced MNPI wall.
- `AUTH_SECRET`, `AUTH_REQUIRED` - session signing + enforce login (drop the anonymous demo tenant).
- `LLM_PROVIDER` / `LLM_MODEL` / `LLM_API_KEY` - the model-agnostic parsing layer (PDF/unstructured).
- `OCR_PROVIDER` - scanned-PDF OCR fallback (default off).
- `SEC_USER_AGENT` - a contact string for SEC EDGAR (no key needed).

SEC EDGAR and ESEF (filings.xbrl.org) and GLEIF need **no key at all**.
