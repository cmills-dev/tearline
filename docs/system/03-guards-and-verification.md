# 3. Extraction guards + verification (the no-fabrication layer)

The product's core promise is that **no figure a user sees is fabricated**. Two mechanisms
*prevent* fabrication (deterministic, external to any model); everything else only *reduces* error.

## Prevention gate 1 - the verbatim-quote guard (`lib/llm/extract.ts`)

Used when the model-agnostic parsing layer reads an unstructured document. Every extracted figure
must carry a `sourceQuote`, and it survives only if **both**:

1. `quoteIsAnchored` - the quote appears verbatim in the document (whitespace/case-normalised), AND
2. `valueGroundedInQuote` - the figure's own digits appear **inside** that quoted span.

The second check closes the "right quote, wrong number" hole (a model quoting a real sentence but
reporting a value not in it). A hallucinated quote fails `str.find`; the model cannot talk past it.
This matches the recent "Double-Lock Grounding" literature. The deterministic sources (SEC, iXBRL,
ESEF) do not need this - their figures come straight from tagged data.

## Prevention gate 2 - verification identities + scale/sign sanity (`lib/engine/verify.ts`)

`runStructuralChecks(facts, period)` runs on **every source** before assembly. Two kinds of check:

- **Accounting identities** - balance sheet (assets = liabilities + equity), net assets = equity,
  trading (turnover - cost of sales = gross profit), and working capital (current assets - creditors
  within one year = net current assets). A pass upgrades an R1 fact to STRUCTURAL_PASS; a failure is
  surfaced as STRUCTURAL_FAIL.
- **Scale + sign sanity** - operating profit <= turnover (a 1,000x scale misread trips this
  instantly), D&A within [0, turnover], cash/borrowings non-negative. A failing sanity check is a
  real defect (STRUCTURAL_FAIL); a passing one is only weak evidence and does not upgrade a fact.

Tolerances are **granularity-aware** (`max(1, 0.5% of magnitude)`) so identities hold on SEC billions
and whole-pound fixtures alike.

## The resolution ladder as an honesty device

Abstention is a first-class outcome. A dropped-but-correct figure costs coverage; a surfaced-but-wrong
figure costs trust. So the ladder always prefers R4 (abstain, with an attempt log) over a guess, and
labels every proxy (R3) with its bias direction.

## OCR text is a candidate, never a trust anchor (`lib/ocr/`)

The scanned-PDF OCR fallback (default off) feeds OCR text into the **same** `extractFinancialsFromText`
+ scale/tripwire abstention. OCR figures are tagged `ocr:` in provenance and low-confidence pages are
dropped. A VLM, if ever added, must be forced through the verbatim-quote guard against the OCR text -
never allowed to read pixels as the sole source.

## The eval proves it

`npm run eval` scores every path into four cells (correctly-surfaced / correctly-abstained /
wrongly-surfaced / wrongly-abstained) and **fails CI on any wrongly-surfaced** figure. Current: 100%
precision on surfaced figures across synthetic and real SEC data. See
[06-testing-and-eval.md](06-testing-and-eval.md).
