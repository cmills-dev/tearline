# UK gold set

Frozen UK accounts filings with hand-keyed figures, for testing the scanned-accounts reader
(WP-BE04 and WP-BE05) against real Companies House documents. Part 1 was built by WP-BE03 on
Tue 15 Sep 2026. Part 2 (WP-BE17, Tue 22 Sep) keys the rest: at least three figures on every
filing, facilities on five, structured ties, and a provisional `claude-checked` label on the ten
spot-check figures, because Cam's own check has not happened yet.

Since WP-BE13 (24 Sep) this set is scored by `npm run eval` through `eval/gold/uk-run.ts`, offline, from the recorded reads in each case folder (`reads.json`). `npm run eval:uk:live` re-records them. A stale recording is listed and not scored. `npm run eval` still exits 0 on it and prints NOT A RELEASE PASS; `npm run eval:uk:strict`, the release gate, exits 2 (26 Sep, while the API account has no credit).

## Files

| Path | What it is |
|---|---|
| `eval/gold/uk.ts` | The cases and figures (`UK_GOLD`). |
| `eval/gold/fixtures/uk/<company number>-<made-up date>/` | One folder per filing: `filing.pdf`, `filing.xhtml` or `filing.json`, and `meta.json`. |
| `eval/gold/uk/freeze.ts` | Fetches each filing again by company number and transaction id. |
| `eval/gold/uk/tags.ts` | Prints the tag-derived figures from the frozen iXBRL and ESEF files. |
| `eval/gold/uk/spot-check-2026-09-16.md` | The ten figures Cam checks by hand. |

## Why the statuses matter

The system under test is Claude reading scanned accounts. The agent that keyed these figures
was also Claude, reading the same scans. A gold set keyed only by an agent shares its blind
spots, so no agent-read figure counts as checked until a person has looked at it.

| Status | Meaning |
|---|---|
| `candidate` | Read off the page by an agent. Not checked. |
| `tie-checked` | Read by an agent, and a printed arithmetic identity on the same page holds with it (for example, the balance sheet totals). Stronger than candidate, still not checked by a person. |
| `tag-derived` | Taken from iXBRL or ESEF tags by the existing extractors. No model and no eye read it. |
| `claude-checked` | **Provisional. Not a person's check.** The ten spot-check figures, which Claude's visual read of each page image and a local Apple Vision OCR presence test both agree with (21 Sep). Each carries both checks in its `checks` field. Applied by WP-BE17 on 22 Sep at Cam's decision, while his own check is outstanding. |
| `cam-checked` | Cam opened the page and the figure, sign and scale were right. Unused so far. |
| `cam-corrected` | Cam opened the page and gave the right value, which replaced the candidate. Unused so far. |

Only `cam-checked` and `cam-corrected` count as checked by a person. Code must ask
`isPersonChecked()` in `eval/gold/uk.ts`, never test for "checked" in a status name.
`eval/gold/uk-verify.ts` prints precision per label and the number of person-checked figures,
which today is 0.

**When Cam does the spot check.** For each of the ten rows, set `status` to `cam-checked` (or
`cam-corrected` with the corrected `value`), and append
`{ by: "cam", date, result, person: true, source: "product/eval/gold/uk/spot-check-2026-09-16.md" }`
to `checks`. Leave the two machine checks in place as history. No other figure changes. If he
finds more than 2 of the 10 wrong, every agent-read figure goes back to `candidate` until a
second check, as the backlog says. `test/ukGold.test.ts` fails if a figure claims a person's
check without that entry.

Ties keyed from WP-BE17 on are data (`UK_TIES`), and `test/ukGold.test.ts` recomputes each
one. A tie that does not hold is kept with `holds: false` and a reason.

A tie proves the digits are consistent with each other. It does not prove the right line
was picked, or the right scale. That is what the spot check is for.

## Conventions

- `metric` uses the WP-BE01 base line keys (`lib/vision/types.ts`, snake_case). Lines with
  no WP-BE01 key say so in the name (`borrowings_total`, `current_assets`).
- `value` is in pounds with the scale applied. Agent-read figures keep the printed sign, so a
  bracketed liability is negative. Tag-derived figures keep the extractor's sign, so costs
  are positive.
- `pdfPage` is the 1-based page index in the PDF, which is the number Preview shows.
  `printedPage` is the number printed on the page. They differ in most filings, by 0 to 3.
- Every case notes what was not read.

## Size rule

A document is committed only if it is 15 MB or less, and only while the whole
`fixtures/uk` folder stays at 90 MB or less. A filing over the limit gets `meta.json` alone,
with `bytesCommitted: false`, and `freeze.ts` fetches it again. In part 1 all 13 filings
fitted (72.3 MB in total; the largest is the Tesco scan at 14.3 MB).

`meta.json` holds the transaction id, filing type, made-up date, accounts type, page count,
bytes, sha256, the public Companies House document metadata URL, `textLayerChars` (the
length of the PDF text layer: 2 means an image-only scan), `bytesCommitted`, the case kind
and notes. It holds no key and no auth header.

## Fetching a filing again

From `product/`, with `CH_API_KEY` in `.env.local`:

```
npx tsx --env-file=.env.local eval/gold/uk/freeze.ts              # every filing
npx tsx --env-file=.env.local eval/gold/uk/freeze.ts 02662226     # one company
npx tsx --env-file=.env.local eval/gold/uk/freeze.ts --check      # compare sha256, write nothing
npx tsx eval/gold/uk/tags.ts                                      # tag-derived figures, no network
```

Filings are fetched by transaction id, never "latest", so a newer filing cannot change the
set. The script waits 600 ms between Companies House requests.

## The cases

| # | Company | Number | Kind | Filing | Pages | Why it is here |
|---|---|---|---|---|---|---|
| 1 | Bristol Water | 02662226 | scan-full | AA, 31 Mar 2026 | 28 | 8.75% irredeemable preference shares, which must stay outside borrowings |
| 2 | Pret A Manger Limited | 11391321 | subsidiary | AA, 1 Jan 2026 | 27 | Audit-exempt subsidiary; parent Pret Parent Holding Limited (13383544) frozen as `parent.pdf` |
| 3 | Boparan Holdings | 03558065 | scan-group | AA, 26 Jul 2025 | 113 | Group scan, pension deficit below the line |
| 4 | Topps Tiles | 03213782 | large-group | AA, 27 Sep 2025 | 226 | Group scan over 200 pages, IFRS 16 leases |
| 5 | James Fisher and Sons | 00211475 | large-group | AA, 31 Dec 2025 | 210 | Group scan over 200 pages |
| 6 | Tesco PLC (ESEF) | 00445790 | esef | ESEF, 28 Feb 2026 | n/a | Tag-derived figures, and the answers for the Tesco scan |
| 7 | Tesco PLC (scan) | 00445790 | large-group | AA, 28 Feb 2026 | 236 | Page-finding (WP-BE15); no figures |
| 8 | Busy Bees Nurseries | 03454787 | ixbrl | AA, 31 Dec 2025 | 60 | The iXBRL filer from the audit sample |
| 9 | Busy Bees Day Nurseries | 00861615 | ixbrl | AA, 31 Dec 2025 | 9 | **Stand-in.** Dormant. WP-BE17 replaces it with a mid-size iXBRL filer |
| 10 | Travelodge Hotels | 00769170 | scan-full | AAMD, 31 Dec 2024 | 69 | Amended accounts; lease liabilities are the only debt |
| 11 | Matalan Retail | 02103564 | scan-full | AA, 28 Feb 2026 | 86 | `£'m` caption variant, loans from group undertakings |
| 12 | PizzaExpress Limited | 01404552 | scan-full | AA, 29 Dec 2024 | 26 | `£000` caption, a small preference share line |
| 13 | Solid State | 00771335 | scan-group | AA, 31 Mar 2026 | 140 | `£'000` caption, bank facilities note |

How cases 10 to 13 were chosen: from the brief's list, by Companies House metadata. Wagamama,
Away Resorts and Italian Coffee Holdings were skipped because their latest filings are
audit-exempt subsidiary accounts, not full or group accounts. The four chosen give an AAMD, a
spread of page counts (26 to 140) and three different scale captions.
