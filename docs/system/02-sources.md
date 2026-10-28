# 2. Data sources

`lib/sources/` - each source maps into the one `FactManifest` shape, so everything downstream is
source-agnostic. Every source abstains rather than guesses. Routing preference: **structured before
document, document before model, and entitled feeds before all** (see
[docs/extraction-strategy.md](../extraction-strategy.md)).

## SEC EDGAR - `secEdgar.ts` (US, no key)

US filers tag their statements in full. `resolveCik(ticker|CIK)` -> `getCompanyFacts` /
`getSubmissions` from `data.sec.gov` -> `extractEdgarFinancials` maps us-gaap concepts (Revenues,
OperatingIncomeLoss, D&A, cash, debt, interest) to base metrics -> `mapEdgarToManifest` builds R1
facts + runs the ladder + verification. `assembleEdgarTearSheet(query)` is the full path. No key;
SEC asks only for a `SEC_USER_AGENT` contact string. This is the highest-reliability jurisdiction.

## Companies House - `companiesHouseLive.ts`, `companiesHouse.ts` (UK, `CH_API_KEY`)

The structured register (profile, officers, charges) carries **no P&L**, so financial lines abstain
until an accounts document is read. `buildLiveFactManifest(number)` tries, in order:

1. **iXBRL** (`getLatestAccountsIxbrl` -> `ixbrl.ts`) - the tagged accounts, when filed electronically.
2. **PDF text layer** (`getLatestAccountsPdfBytes` -> `pdfAccounts.ts`) - deterministic labelled-line
   extraction for PDF filers.
3. **OCR** (`lib/ocr/`, default off) - only for scanned-image PDFs when a provider is configured.
4. Otherwise the financial lines abstain (R4), while structured facts + charges (capital structure)
   resolve at R1.

Capital structure is built from the **charges register** (each secured charge -> a tranche with its
chargee/lender). Best-effort **LEI enrichment** (`gleif.ts`) attaches the entity's LEI.

Document download (`fetchDoc.ts`): the CH content endpoint 302-redirects to a pre-signed S3 URL; the
Authorization header goes only to CH (never forwarded to S3), with retry/backoff and an exact
abstain-vs-retry split. This fixed the intermittent zero-byte bug.

## iXBRL reader - `ixbrl.ts`

A prefix/namespace-tolerant regex parser (no DOM dependency). Reads contexts, units, and
`nonFraction` facts; `pickLatest` selects the current year over the prior-year comparative. Concept
maps (case-insensitive local names) cover the P&L base lines AND the **balance sheet** (net assets,
current assets, creditors within/after one year, cash, net current assets), so **filleted and
micro-entity** accounts - which omit the P&L - still yield real balance-sheet credit signals while
turnover/EBITDA honestly abstain.

## PDF text-layer extractor - `pdfAccounts.ts`

`extractFinancialsFromText(text, sourceTag)` - deterministic and conservative. Detects the statement
scale (abstains if none is declared, avoiding a 1,000x error), reads the current-year column from
labelled lines, normalises sign/scale (parentheses = negative), keeps the verbatim source line as the
grounding snippet, and abstains on an internal scale mismatch (operating profit > turnover). `pdfToText`
uses `unpdf` (pure JS). Large UK filers lodge scanned images (no text layer) -> this abstains, which
is why the OCR layer exists.

## ESEF / UKSEF - `esef.ts` (EU/UK-listed, no key)

The same issuer that lodges a scanned PDF at CH files clean tagged iXBRL with its regulator.
`latestEsefFiling(lei)` pulls pre-computed xBRL-JSON from **filings.xbrl.org**; `extractEsefFinancials`
keeps only **consolidated totals** (facts with no company-extension/segment dimension) and only
`ifrs-full:` concepts (abstains on extensions), then maps to the manifest + ladder. Keyed by LEI
(resolved via GLEIF). Validated on Tesco (revenue GBP 73,712m, statutory operating profit GBP 2,985m).

## GLEIF / LEI - `gleif.ts` (no key)

`resolveLei(query, { chNumber?, country?, withParents? })` - the cross-source join key. Deterministic
by Companies House number (accepted only on an unambiguous single Companies-House-registered hit);
scored fuzzy match by name with strict abstain thresholds (weak best, ambiguous top-two, inactive).
Parent/ultimate-parent LEIs from the relationship endpoints. A wrong LEI would corrupt everything
downstream, so it abstains rather than mis-link.

## Fixtures - `lib/sources/fixtures/`

Two illustrative synthetic borrowers (Meridian, Redacta) used by `/sheet/*`, always stamped
synthetic. Redacta exercises the filleted path (P&L abstains, balance sheet resolves).
