# 5. App + routes

Next.js App Router (`app/`). Server components render the tear sheet from the manifest; the deterministic
engine runs server-side. Routes are dynamic where they touch a tenant or live data.

## Routes

| Route | Purpose | Source |
|-------|---------|--------|
| `/` | Entry field (name/tip in) + demo borrowers + links to the other surfaces | `page.tsx` |
| `/sheet/[key]` | Engine A tear sheet for a fixture, generated-then-saved to the tenant workspace, reloaded from store | `workspace.ts` -> fixtures |
| `/live` | Companies House live search -> a cited, partial tear sheet on a real UK name | `companiesHouseLive.ts` |
| `/sec` | A US ticker/CIK in -> a full, cited tear sheet (deterministic, no key) | `secEdgar.ts` |
| `/screen` | Engine B: a mandate in -> a ranked, evidence-backed list of names | `engineB/` |
| `/workspace` | The tenant's saved tear sheets (per-browser or per-user) | `workspace.ts` |
| `/api/health`, `/api/model/[key]` | Health + workbook/model export | - |

Middleware (`middleware.ts`) assigns the anonymous `tid` tenant cookie on first visit (demo mode).

## Key components (`app/components/`)

- **EntryField** - the name/tip input on the home page.
- **SheetView** - renders a `TearSheet`: financial table with trend/delta cells, capital structure with
  the fulcrum, EvidenceCards (click a figure -> its source snippet, rung badge, verification state,
  content hash), CSV export. Client component; reads only the assembled view model.
- **ScreenView** - the Engine B mandate form + ranked results with per-name evidence and honest
  hard-filter exclusions.
- **DataModeChrome** - surfaces whether data is live/synthetic/durable honestly.

## Honesty in the UI

Every figure links to its source; every sheet shows its provenance and method (from-feed / from-XBRL /
from-PDF / abstained); synthetic demo data is stamped; abstention renders as "Not disclosed" with a
reason, never a blank or a zero. The redaction-bar wordmark reflects that the product name is
deliberately undecided.
