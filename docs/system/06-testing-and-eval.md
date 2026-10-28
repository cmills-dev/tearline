# 6. Testing + the eval gates

## Unit tests (`test/`, `npm test`)

A tiny custom harness (`test/harness.ts`: `suite` / `test` / `assert` / `assertEqual`) run by
`test/run.ts` via `tsx`. Deterministic and offline - live-data suites use mock fetches, so there is
no network flakiness in CI. Sync suites register on import; async suites register via an awaited
registrar. 148 tests today, covering: the ladder, ProseGate, the language plane, contracts + store,
iXBRL (P&L + filleted balance sheet), SEC EDGAR mapping + verification, PDF text extraction, the
CH->S3 download helper, GLEIF resolution, ESEF extraction, the OCR fallback, the verbatim-quote guard,
auth crypto/sessions, hosting (cache/rate-limit), and the workspace tenant loop.

Add a suite: create `test/<name>.test.ts`; import it in `run.ts` (sync) or export a
`register<Name>Tests()` and await it in `main()` (async).

## The extraction eval gates (`eval/`, `npm run eval`)

The metric that matters is **precision on surfaced figures = 100% (zero fabricated numbers)**;
abstention is scored as a first-class outcome. Two runners:

- `eval/extraction.ts` - the broad path check across synthetic SEC, the PDF text-layer extractor
  (including abstain-on-no-scale and abstain-on-scale-mismatch), the verbatim-quote guard, and the
  fixture pipeline.
- `eval/gold/run.ts` (`npm run eval:us`) - the **real-data CI gate**: frozen, trimmed live SEC
  Company-Facts snapshots for Apple / Microsoft / Coca-Cola (`eval/gold/fixtures/*.json`), with
  `eval/gold/us.ts` holding the expected values (turnover and operating profit hand-verified against
  the cited 10-K accession). Each snapshot runs the real `mapEdgarToManifest -> ladder -> verify`
  path and is classified into four cells.

Both **exit non-zero on any wrongly-surfaced figure**, so they gate CI. Refresh the SEC snapshots
deliberately (re-fetch trimmed Company Facts, re-verify the top lines against the filing).

Four cells:

| | expected value | expected ABSTAIN |
|---|---|---|
| **surfaced** | correctly-surfaced | wrongly-surfaced (**fabrication - must be 0**) |
| **abstained** | wrongly-abstained (recall leak) | correctly-abstained |

## Live tests

Sources with no key (SEC, ESEF, GLEIF) can be smoke-tested live directly; CH needs `CH_API_KEY`. Keep
live smokes separate from the deterministic unit suite (network + drift). A nightly live-smoke job
(throttled, with a User-Agent) is the right home for detecting upstream drift.
