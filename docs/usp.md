# The USP

Synthesised from the origination-expansion research pass. Positioning in one line:

> **The only origination layer that fuses a live, document-cited credit catalyst with your firm's own
> relationship graph, runs inside your existing data licences, and shows its work on every claim.**

## The three moats, in priority order

**1. The "why-you, why-now" origination graph (primary, defensible whitespace).**
Engine C surfaces a target only when BOTH halves are individually auditable to a document: a cited
credit catalyst (the *why now* - a maturity/refinancing window, elevated leverage, thin cover, a new
charge, an ownership change, all traced to a filing) AND a real, provenanced warm path through the
firm's own network (the *why you*). No incumbent sits at this intersection: credit/research tools
(Octus, AlphaSense, CreditSights) read the filing but not your network; relationship-intelligence
tools (Affinity, DealCloud, 4Degrees) own the network but do not read filings to filing-grade;
firmographic sourcing (Grata, Cyndx, Sourcescrub) is opaque. We already own the hard, honest half -
the Fact / Provenance / Rung spine, GLEIF resolution, the verbatim-quote guard - so this is the
shortest path to something no competitor can cheaply assemble.

**2. BYO-entitlement as a compliance-and-neutrality moat (co-primary, structural).**
We run inside the client's own data licences and never redistribute data; the private relationship
layer is built from the client's own CRM/mailbox export and from public primary filings. This is an
incumbent's-dilemma moat: PitchBook/Octus cannot copy it without cannibalising the data-reseller
revenue that is their business, and market-data redistribution law makes copying genuinely hazardous.
It maps directly onto the per-tenant RLS wall we already have.

**3. Conversational onboarding as the per-tenant compounding loop (enabling flywheel).**
Every confirmed mandate, relationship, entitlement, and accept/reject on a suggestion makes *that*
tenant's ranking better and their switching cost higher - and none of it is resold. This turns #1
from a feature into a moat that compounds over time.

## What NOT to headline

Do **not** lead with "honest citations / no fabrication." Octus already claims it and it is becoming
table stakes. Keep it as the **trust substrate** that makes #1 and #2 believable - the reason a credit
committee will act on a suggestion - not the pitch.

## How the build maps to the USP

- The tear-sheet engine (Fact/Provenance/Rung, verification gate, verbatim-quote guard) = the trust
  substrate.
- `lib/graph/` + `lib/originate/` = USP #1 (why-you, why-now), with the hard gate and abstention.
- The tenant-scoped store + RLS wall + `source_entitlement` = USP #2 (BYO).
- `lib/onboarding/` = USP #3 (the compounding per-tenant loop).
