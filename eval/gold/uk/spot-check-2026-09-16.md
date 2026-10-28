# UK gold set: spot check for Wed 16 Sep 2026, 09:15

Open each file in Preview, go to the page, find the line, and write right, wrong, or the correct value.

In Preview, Go > Go to Page (Option-Command-G) takes the PDF page number below. The printed
page number on the sheet itself is shown in brackets where it differs.

Files are under `product/eval/gold/fixtures/uk/` after the 09:00 merge. If the merge is
late, the same files are in the worktree:
`/Users/student/Documents/Claude/origination-wt/wp-be03/product/eval/gold/fixtures/uk/`

| # | Company | File to open | PDF page | Line as printed | Printed text | Scale | Candidate value in pounds | Cam: right, wrong or correct value |
|---|---|---|---|---|---|---|---|---|
| 1 | Bristol Water | `02662226-2026-03-31/filing.pdf` | 10 | 8.75% irredeemable cumulative preference shares (under Non-current liabilities, on its own line, not in Borrowings), 2026 column | (12.5) | £m | -12,500,000 || Claude visual read 21 Sep: right. Its own line under Non-current liabilities, separate from Borrowings (1.6) |
| 2 | Bristol Water | `02662226-2026-03-31/filing.pdf` | 10 | Cash and cash equivalents, 2026 column | 1.7 | £m | 1,700,000 || Claude visual read 21 Sep: right |
| 3 | Bristol Water | `02662226-2026-03-31/filing.pdf` | 9 | Operating profit(loss), 2026 column | (0.7) | £m | -700,000 || Claude visual read 21 Sep: right |
| 4 | Travelodge Hotels | `00769170-2024-12-31/filing.pdf` | 32 (printed 30) | Lease liabilities under NON-CURRENT LIABILITIES, 2024 column | (2,578.6) | £m | -2,578,600,000 || Claude visual read 21 Sep: right. Non-current lease liabilities (2,578.6), 2024 column |
| 5 | Matalan Retail | `02103564-2026-02-28/filing.pdf` | 42 (printed 40) | Net liabilities, 2026 column | (66.6) | £'m | -66,600,000 || Claude visual read 21 Sep: right |
| 6 | PizzaExpress | `01404552-2024-12-29/filing.pdf` | 9 (printed 6) | Cash and cash equivalents, 29 December 2024 column | 17,375 | £000 | 17,375,000 || Claude visual read 21 Sep: right |
| 7 | Solid State | `00771335-2026-03-31/filing.pdf` | 93 (printed 91) | Non-current borrowings, 2026 column | (10,142) | £'000 | -10,142,000 || Claude visual read 21 Sep: right |
| 8 | Boparan Holdings | `03558065-2025-07-26/filing.pdf` | 59 | Cash at bank and in hand, 26 July 2025 column | 105.4 | £m | 105,400,000 || Claude visual read 21 Sep: right |
| 9 | Boparan Holdings | `03558065-2025-07-26/filing.pdf` | 91 | Note 21 Borrowings, text under the table: "The Group has an £80.0m super senior secured RCF" | £80.0m | £m | 80,000,000 || Claude visual read 21 Sep: right. Facility size, undrawn at year end |
| 10 | Solid State | `00771335-2026-03-31/filing.pdf` | 117 (printed 115) | Note 19 Bank borrowings and facilities, text under the tables: "The facility is for £15.0m" | £15.0m | £m | 15,000,000 || Claude visual read 21 Sep: right. Facility size; drawn 10,142 is separate |

**Checked Mon 21 Sep 2026 18:45 by Claude (session 3de13e6d), at Cam's request, reading each rendered page image. Not Cam's own check: WP-BE17 should mark these `claude-checked`, not `cam-checked`, unless Cam confirms. 10 of 10 right.**

**What "right" means.** The figure, its sign and its scale all match. Brackets mean a negative
value, so "(12.5)" under a £m caption is -12,500,000. A figure on the right line but in the
wrong column (last year instead of this year) is wrong. For row 1, also write wrong if the
preference shares are part of borrowings on the page. For rows 9 and 10 the amount is the
facility's size, not what was drawn.

Ten rows, about two to three minutes each. When done, leave the sheet as it is: WP-BE17 reads
this column and marks each figure `cam-checked` or `cam-corrected` in `eval/gold/uk.ts`. If more
than 2 of the 10 are wrong, every agent-read figure in the set stays a candidate until a
second check.

**Applied provisionally by WP-BE17, Tue 22 Sep 2026.** At Cam's decision, the ten figures above are
labelled `claude-checked` in `eval/gold/uk.ts`, not `cam-checked`. That label counts as a machine
check everywhere precision is reported. The table above holds Claude's reads, not Cam's; Cam has not entered a result on any row. When Cam does,
his results replace `claude-checked` on these ten figures (see `README.md`, "When Cam does the
spot check").
