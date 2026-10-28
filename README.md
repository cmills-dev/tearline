# Tearline

An AI origination engine for private equity, private credit and restructuring desks. A company name or deal tip goes in, and a cited tear sheet comes out, with every figure traceable to the exact page of the public filing it came from. The language model never originates a number.

A name in, a cited tear sheet out. This is the product, not a marketing site: type a UK
borrower and a decision-grade tear sheet assembles in front of you, with every figure
clickable back to the exact source it came from.

The build deliberately does not look like a thin LLM wrapper. Five differentiators are
implemented as real code, not copy:

1. **Fact-manifest-first.** A tear sheet is a typed `FactManifest` before it is a
   document (`lib/engine/types.ts`). Numbers live in facts with provenance. The
   language plane (`lib/engine/languagePlane.ts`) may only *reference* fact ids through
   tokens. A template that contains a bare digit is rejected before rendering, so prose
   cannot originate or alter a number. No live LLM is called; prose is deterministic.
2. **Resolution ladder** (`lib/engine/ladder.ts`). Every derived field resolves through
   R1 reported → R2 synthesised (declared formula) → R3 labelled proxy (bias-flagged) →
   R4 abstain-with-attempt-log. Never a silent blank. "Reported" is reserved for R1.
3. **Evidence cards** (`lib/engine/assemble.ts`, drawer in
   `app/components/SheetView.tsx`). Every figure opens a card showing the source
   document, locator, rendered snippet, rung, derivation/proxy and a content hash. The
   card is rendered once at assemble time; the viewer only reads it.
4. **ProseGate** (`lib/engine/prosegate.ts`). A pure-code linter (no model) that blocks
   banned AI-tell words, hedging, negative parallelism, process narration and em-dashes.
   All shipped prose passes through it; unit-tested.
5. **Verification** (`lib/engine/verify.ts`). Cross-field identities (balance sheet,
   net assets, trading account) are run and shown. Honest labels only: a single
   unchecked source is "single source", never "verified".

## Run it

```bash
cd product
npm install
npm run dev        # http://localhost:3000
```

Other scripts:

```bash
npm run build      # clean production build (all pages prerender)
npm test           # the full suite: 1,362 tests (engine, ladder, ProseGate, sources, routes)
npm run eval       # extraction eval against the gold set of real UK filings in eval/gold
npm run start      # serve the production build
```

## Evaluation

`eval/gold` holds a gold set of 10 real UK company filings from Companies House, each with hand-checked figures. `npm run eval` extracts every field and compares it with the gold value. Where the printed figures do not reconcile (a maturity split that does not add to total borrowings, a column with no period), the engine abstains and says why, rather than guess. Abstentions are reported separately and are not counted as failures.

## Data honesty

There is no live Companies House key required to run this. The demo runs on **two
clearly-labelled illustrative synthetic borrowers**. A persistent stamp reads
"Illustrative — synthetic data". No figure describes a real entity.

- **PROJECT MERIDIAN (illustrative)** — data-rich, full accounts. Most lines resolve at
  R1/R2 and the balance sheet identity passes, so the sheet is clean.
- **PROJECT ▮▮▮▮ (illustrative)** — filleted small-company accounts. Turnover is not
  filed (forces R4 abstain), EBITDA cannot be built from a split D&A (forces an R3
  proxy on EBIT), and leverage inherits and flags that proxy bias. The ladder does
  visible work.

## Live connector (ready to flip)

`lib/sources/companiesHouse.ts` is a real connector to the Companies House Public Data
API (`https://api.company-information.service.gov.uk`), with response types matching the
real API and the fixtures conforming to the same shapes. It is gated behind
`CH_API_KEY`: with no key the app runs on fixtures; set the key (see `.env.example`) and
the header banner switches to live mode.

## Deploy

Standard Next.js App Router, no exotic config. Vercel-deployable as-is: import the repo,
set the root to `product/`, deploy. Add `CH_API_KEY` as an environment variable to flip
to live data. `node_modules` is git-ignored.

## Design

Confidential Memorandum system: warm paper `#F4F1EA`, ink `#3A3936`, a single rare
maroon accent `#7B2231`, Libre Caslon headlines and Courier Prime for all body and every
number (tabular figures). Sharp corners throughout, flat printed depth, hairline rules,
redaction as a meaningful device. Fonts are embedded as base64 `@font-face`
(`app/fonts.css`), so there are no external font requests.


## Data and licence

The evaluation fixtures in `eval/` are UK company filings from Companies House, used under the Open Government Licence v3.0 (contains public sector information licensed under the OGL). The code is released under the MIT licence, see `LICENSE`.
