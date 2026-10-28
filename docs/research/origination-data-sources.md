# Origination data sources - verified research (2026-08)

Verified facts behind the origination expansion (maturity catalysts, monitoring, universe
screening, distress catalysts). Everything here was checked against a primary source this
month. Where a fact is from training and not re-verified, it is marked UNVERIFIED.

## Companies House REST API

Base: `https://api.company-information.service.gov.uk`. Auth: HTTP Basic, the API key as
username, blank password. Standard rate limit c. 600 requests per 5 minutes (the app already
guards this). Docs: developer-specs.company-information.service.gov.uk.

### Distress and status (first-party, cited)

- `GET /company/{number}/insolvency` returns `cases[]`, each with a `type` from the enum:
  compulsory-liquidation, in-administration, creditors-voluntary-liquidation,
  members-voluntary-liquidation, administrative-receiver, administration-order,
  corporate-voluntary-arrangement, receiver-manager, moratorium,
  order-of-court-restructuring-plan, corporate-voluntary-arrangement-moratorium (+ moratorium
  sub-events). Each case carries `dates[]` (a `type` such as administration-started-on,
  wound-up-on, voluntary-arrangement-started-on, moratorium-started-on, plus the date) and
  `practitioners[]`. This is the primary distress catalyst source: company-number keyed, dated,
  enumerated, R1-citable. 404 when there is no insolvency history.
- `GET /company/{number}` profile carries: `accounts.next_accounts.overdue` (bool),
  `confirmation_statement.overdue` (bool), `company_status` (active | liquidation | receivership
  | administration | voluntary-arrangement | insolvency-proceedings | dissolved | ...),
  `company_status_detail` (e.g. active-proposal-to-strike-off), `has_insolvency_history` (bool).

### Charges

- `GET /company/{number}/charges` items carry `created_on`, `delivered_on`, `satisfied_on`,
  `status` (outstanding | part-satisfied | fully-satisfied | satisfied), `particulars`,
  `secured_details`, `persons_entitled`, `classification`. There is NO maturity or end date on a
  charge, so charge age (vintage since `created_on`) is only a refinancing PROXY (R3), never a
  maturity date.

### Universe building

- `GET /advanced-search/companies` filters: `sic_codes` (multiple), `company_status` (multiple),
  `company_type`, `company_subtype`, `incorporated_from`, `incorporated_to`, `dissolved_from/to`,
  `location`, `company_name_includes/excludes`. Pagination `size` (1..5000) and `start_index`.
  Shares the standard rate limit.

## The Gazette

Free under the Open Government Licence, so commercial reuse is permitted (the licence excludes
personal data, but corporate insolvency notices are fine). A linked-data API (JSON-LD / XML) plus
a SPARQL endpoint. Company-number keying is weaker than the CH `/insolvency` endpoint, so it is a
secondary corroboration source, not the primary. Deferred for v1. Docs: thegazette.co.uk/data.

## Going concern, audit opinion and maturity, from FRC iXBRL

Source: FRC 2025 Taxonomy Suite (schema/label files grepped directly). Namespaces `core:`
(financial concepts) and `aurep:` (auditor's report).

- There is NO boolean or enumerated tag for "material uncertainty over going concern" or for a
  qualified/modified opinion. The only structured concepts are free-text string blocks:
  - `aurep:DescriptionMattersGivingRiseToAnyModifiedAuditOpinion` exists ONLY when the opinion is
    modified (qualified / adverse / disclaimer), so its presence is a usable R3 distress hint.
  - `core:DescriptionWhyEntityNotGoing-concernOrUncertaintiesOverGoing-concernStatus` is present
    when the filer discloses a non-going-concern basis OR uncertainties (read the text to classify).
  - `aurep:OpinionAuditorsOnEntity` / `BasisForOpinionAuditorsOnEntity` are the full opinion text.
  - Most small, filleted or unaudited filings carry NO `aurep:` facts at all - abstain, and never
    infer a clean opinion from absence.
- Material uncertainty is therefore a TEXT heuristic. Fire only on ISA 570 wording: the section
  heading "Material Uncertainty Related to (or Relating to) Going Concern", or "may cast
  significant doubt" co-occurring with "continue as a going concern", or a non-going-concern basis
  ("not prepared on a going concern basis", "break-up basis"). CRITICAL: exclude negated forms -
  "no / not / without material uncertainty" appears in most healthy accounts and must not fire.
  A plain going-concern basis note is normal and is NOT a signal.
- Balance-sheet distress, sound R1 from concepts the extractor already lands:
  - Net liabilities: negative `core:NetAssetsLiabilities` (or negative equity). Genuine R1 signal,
    but can reflect intragroup funding or early-stage losses, so annotate rather than assert
    imminent insolvency.
  - Net current liabilities: negative `core:NetCurrentAssetsLiabilities`. A working-capital
    PRESSURE signal, often benign (parent-funded subs, negative-working-capital models), so do not
    escalate to distress without corroboration.
- Debt maturity bands exist only as members of `core:MaturitiesOrExpirationPeriodsDimension`
  (WithinOneYear, AfterOneYear, BetweenOneTwoYears, BetweenTwoFiveYears, BetweenFourFiveYears,
  MoreThanFiveYears) attached to `core:Creditors` / borrowings via a dimensional context. A true
  band is R1 only if the dimensional context is read; most small filings omit it entirely. The
  after-one-year bucket alone is a coarse R3 proxy (12 months to 30 years), never a maturity date.

## Doctrine consequences

Every new signal is cited to one of the above or it abstains. The strong, first-party, R1
catalysts are the insolvency cases, the not-active status, the overdue flags, and negative net
assets / net current assets. Going concern and audit modification are text or structured-presence
hints (R3), abstain-heavy. Charge vintage and the after-one-year creditor bucket are labelled
proxies, never maturity dates. The Gazette is a deferred OGL enrichment.
