# 1. Engine core

`lib/engine/` - the source-agnostic heart. It takes typed facts with provenance and turns them into
a decision-grade tear sheet, enforcing honesty at every step.

## FactManifest and Fact (`types.ts`)

Everything is a **FactManifest**: `{ entity, facts, sources, generatedAt }`. A **Fact** is the atom:

```
{ id, metric, label, period, kind, value, unit, rung, provenance, verification }
```

- `value` is `null` **only** at rung R4 (abstain). Numbers live here and nowhere else - prose may
  reference a Fact but can never originate a number (see the language plane).
- `provenance` (`{ sourceId, tag, documentName, locator, snippet, retrievedAt, contentHash }`) points
  at the exact source text. `null` only at R4.
- `verification` is an honest label, never "verified" for a single unchecked source.

`EntityMeta` carries `companyName`, identifiers (`companyNumber`, `lei`, `ultimateParentLei`),
`accountsType`, and `synthetic` (true for illustrative demo borrowers, always stamped).

## The resolution ladder (`ladder.ts`, `buildManifest.ts`)

Every field resolves down a ladder, never a silent blank:

- **R1** reported - a figure taken verbatim from a source, with provenance.
- **R2** synthesised - derived by a declared formula from R1 facts (e.g. EBITDA = operating profit +
  D&A; net debt = borrowings - cash; leverage = net debt / EBITDA). Labelled DERIVED.
- **R3** labelled proxy - a stand-in with a bias flag (e.g. EBIT used for EBITDA when D&A is
  untagged; the Microsoft case in the SEC gold set).
- **R4** abstain - no defensible value; an attempt log is retained. "Reported" is reserved for R1.

`resolveDerivedMetrics(facts, periodKey)` runs the ladder for the declared derived metrics. It is
currency-agnostic (works on SEC USD billions and CH GBP alike).

## Verification (`verify.ts`)

Cross-field identities and sanity checks, run on every source before anything is shown. See
[03-guards-and-verification.md](03-guards-and-verification.md). A pass upgrades an R1 fact to
STRUCTURAL_PASS; a failure is surfaced as STRUCTURAL_FAIL, never hidden.

## ProseGate (`prosegate.ts`) and the language plane (`languagePlane.ts`)

- **ProseGate** is a pure-code linter that blocks AI-tell language (empty intensifiers, hedging,
  process narration, em-dashes) before any prose ships. Machine-sounding prose throws rather than
  ships.
- **The language plane** rejects any prose template that carries a bare digit, so a number can only
  ever reach the page by being a verified Fact. This is the structural guarantee that the narrative
  layer cannot fabricate a figure.

## Assembly (`assemble.ts`)

`assembleTearSheet(manifest, fixture)` builds the view model: the financial table with
period/trend/delta cells, the capital structure with the fulcrum identified, EvidenceCards (each
figure one click from its source snippet, rung badge, verification state, content hash), and the CSV
export. It reads only `periods`, `thesis`, and `capitalStructure` off the fixture; everything else
comes from the manifest.

## Contracts (`lib/contracts/`)

The frozen, versioned schemas (`FactManifest`, `Fact`, `ClientSpec`) with validators
(`validateFactManifest`, `validateFact`, `validateClientSpec`). A manifest that violates the contract
is refused before it can be persisted (`assertPersistable`), so a bad record can never be written.

## Why it is "not a wrapper"

Fact-manifest-first (the sheet is a typed data structure before it is a document), the resolution
ladder, EvidenceCards, ProseGate, and the language-plane guard are all real, tested TypeScript with
no LLM in the deterministic path. The model-agnostic layer is a *fallback* for unstructured
documents, always behind the verbatim-quote guard.
