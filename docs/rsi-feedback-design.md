# RSI: recursive self-improvement from onboarding feedback

Design for a feedback loop where onboarded clients make the system better. Scope chosen:
per-client convergence AND a shared concept dictionary, fed by three feedback sources
(onboarding abstention-resolution, spec edits at activation, rendered-sheet corrections).
This is the plan's Module 1 feedback loop (`docs/engine-sprints.md` S9 to S10), made concrete
against the built code in `lib/clientspec/`.

Status: **Phases 1 to 4 are BUILT and verified.** Phase 1 (per-client, in-silo), Phase 2
(de-identified cross-tenant aggregation), Phase 3 (gated promotion into a shared dictionary), and
Phase 4 (sheet-level corrections) all run. The shared plane ships with its safeguards in place:
one-way KEYED (HMAC) tenant hashes, k-anonymity, an identifying-token filter, a base-conflict
check, an induction eval gate over the 30-sheet gold set, and human sign-off.

Phase 2 to 4 as built: `db/migrations/0008_shared_learning.sql` (three de-identified tables, no
RLS by design); `lib/clientspec/shared{Store,Postgres}.ts` (the global SharedLearningStore,
tenant ids stored only as HMAC digests via `sharedHash.ts`); `lib/clientspec/promote.ts` (the
pure gate policy); `/api/onboarding/shared` (the review + promotion route with all gates + the
eval gate); `/shared-learning` (the analyst review queue); the feedback route contributes each
confirmed resolution to the shared plane; the clientspec route applies the active shared
dictionary after the tenant's own synonyms; `/api/onboarding/correction` + the `/housesheet`
correction control capture sheet-level fixes. Verified end to end: three distinct desks teaching a
term promotes it (single-desk terms are blocked by k-anonymity), and a fourth untaught tenant then
maps it from the shared dictionary, with no client-identifying data anywhere in the plane.

A four-agent adversarial review ran alongside the build. It confirmed the no-fabrication,
tenant-isolation and promotion-gate logic clean, and found five issues, all now fixed: a silent
drop of indented field rows in induction (HIGH, honesty), an unsalted tenant hash (MEDIUM, MNPI,
now HMAC), plus a clientId repin and input-size caps. The indented-rows fix is guarded by a new
gold sheet.

Phase 1 as built: `db/migrations/0007_feedback.sql` (`client_synonym` + `feedback_event` under
RLS); the store gained `addSynonym / listSynonyms / recordFeedback / listFeedback`
(`lib/clientspec/store.ts`, `postgres.ts`); `induceClientSpec` takes the tenant's synonyms and
resolves them before the static dictionary (`lib/clientspec/induce.ts`); `/api/onboarding/feedback`
records a resolution or dismissal; `/api/onboarding/clientspec` loads and applies the tenant's
synonyms on every induction; the wizard lets a client teach a concept for any abstained line.
Verified end to end (function and live HTTP): a label that abstains, once taught, maps on the
next induction, and a different tenant never learns it. Tests: `test/clientspec-feedback.test.ts`
(5) plus the loop is exercised in the suite. Nothing crosses the tenant wall.

## The doctrine constraints this must respect

1. **No fabrication.** A learned mapping is one a human confirmed, never one the system guessed.
   Abstention stays the default. RSI widens what the system KNOWS, it does not loosen the bar.
2. **The MNPI wall.** A client's own labelling is confidential and lives in their silo. Raw
   client terminology must never cross into the shared plane. Only generic, corroborated,
   de-identified vocabulary may be promoted, and only with human sign-off.
3. **Versioned and reversible.** Every spec and every shared-dictionary state is versioned, so
   any learned change can be rolled back and every rendered sheet traces to the versions that
   produced it. `ClientSpec.version` already gives us this per client.
4. **Eval-gated.** The gold eval (100% precision on surfaced figures, 0 fabrications) gates any
   change to the shared dictionary, exactly as it gates code today.

## Feedback taxonomy (what a client tells us)

| Source | Signal | Where it enters | Safe tier |
|---|---|---|---|
| Onboarding abstention-resolution | "this unmapped line IS EBITDA" (teach) or "leave it out" (confirm) | the wizard, step 3 | per-client, promotable |
| Onboarding abstention-resolution | a new label bound to a known concept | the wizard, step 3 | per-client, promotable |
| Spec edits at activation | relabel, required toggle, resolution floor | the wizard, step 4 | per-client only |
| Rendered-sheet corrections | "this field should read differently / is wrong / is missing" | a future review surface on `/housesheet` | per-client, classified |

The only signal that can inform the SHARED dictionary is a label to concept mapping (pure
vocabulary). Floors, required flags, section order and any figure are per-client house style,
never shared.

## Data model (all tenant-scoped, under the existing RLS wall)

- `feedback_event(tenant_id, kind, payload jsonb, created_at)` where kind is one of
  `label_edit | required_toggle | floor_change | abstention_resolved | abstention_dismissed |
  sheet_correction`. The audit trail of everything a client told us. Never leaves the silo.
- `client_synonym(tenant_id, label_norm, concept_key, confirmed_at)` the client's OWN learned
  vocabulary. Applied first at induction time for that client, so their terms map even when the
  shared dictionary does not know them. Pure per-client, no doctrine risk.
- `synonym_candidate(label_norm, concept_key, distinct_tenants int, status)` the shared-plane
  candidate table. Stores only the NORMALISED label, the concept, and a COUNT of distinct
  tenants who independently confirmed it. It does not store which tenant used which label beyond
  the count, so it carries no client-identifying content. `status` is
  `pending | queued | approved | rejected`.
- `shared_dictionary_version(version, entries jsonb, approved_by, created_at)` the versioned
  shared dictionary. Induction records the version it used.

## Two tiers of learning

### Tier 1: per-client convergence (safe, build first)

On re-induction for a client, resolve each label in this order:
1. the client's own `client_synonym` overrides (their confirmed vocabulary),
2. the shared dictionary (current approved version),
3. otherwise abstain (unchanged behaviour).

Their spec converges over versions. The success metric is S10's: deltas per client per month
trending down. No shared state is touched, so this ships without MNPI review.

### Tier 2: shared-dictionary promotion (design now, gate hard)

A confirmed abstention-resolution ("label X means concept Y") becomes a `synonym_candidate`.
A candidate may be PROMOTED to the shared dictionary only when ALL of these hold:

- **k-anonymity:** at least k independent tenants (default k = 3) confirmed the SAME label to
  concept mapping. A term one client uses is idiosyncratic and identifying; a term three
  unrelated desks independently use is generic industry vocabulary. This single gate is what
  keeps a client's signature terminology out of the shared plane.
- **Identifying-token filter:** the label contains no client name, product name or deal
  codename (denylist plus the k gate). Reject anything that smells proprietary.
- **Human sign-off:** an analyst on our side approves the promotion. Never automatic.
- **Eval gate:** promoting the candidate must not regress the gold eval. A new dictionary
  version that drops precision or lifts fabrication is blocked, same as a code regression.

Poisoning resistance falls out of this: no single client (or bad actor) can move the shared
dictionary, because promotion needs k independent confirmations plus a human plus a passing
eval. And every promotion is a new, reversible dictionary version.

## Integration points in the built code

- `lib/clientspec/concepts.ts` `matchConcept()` becomes layered: try client synonyms, then the
  active shared dictionary version, then the static base dictionary, then null (abstain).
- `lib/clientspec/induce.ts` takes the tenant's `client_synonym` set and the shared dictionary
  version as inputs, so induction is a pure function of (text, client vocab, shared version).
- The wizard step 3 (`app/onboarding`) gains an "assign a concept" control on each unmapped
  line, writing a `client_synonym` and a `feedback_event`.
- `db/migrations/0007_feedback.sql` adds the four tables under the same tenant RLS as 0006.
- `eval/` gains a dictionary-promotion gate: re-run the gold set against a proposed dictionary
  version before it can be approved.

## Phased build

1. **Per-client loop (safe):** 0007 migration, `client_synonym` + `feedback_event` capture, the
   abstention-resolution control in the wizard, layered `matchConcept`. Ships with no MNPI
   review. Delivers convergence and the deltas-down metric.
2. **Candidate aggregation (no promotion):** roll confirmed resolutions into
   `synonym_candidate` with distinct-tenant counts. A review surface shows what is trending. The
   shared dictionary is still untouched.
3. **Gated shared promotion:** the k-anonymity + identifying-token + human-review + eval-gate
   pipeline, and the versioned `shared_dictionary`. This is the step that needs the MNPI review
   signed off before it goes live.
4. **Sheet-level corrections:** capture corrections on the rendered house sheet, classify one-off
   versus persistent (S10's classifier), feed persistent ones into the per-client loop.

Recommended: build Phase 1 now (safe, high value, no wall crossing), design-review Phase 3's
promotion pipeline with whoever owns the MNPI policy before building it.
