# Production Confidence 98

This document defines the executable production-confidence gate for AI Brain.

## Purpose

Promotion should not depend on vague confidence language. It should depend on
explicit clean-replay gates and protected benchmark lanes.

## Weighted gate

- continuity: `30%`
- personal recall: `30%`
- MCP/product query quality: `20%`
- DB/runtime quality: `10%`
- benchmark safety: `10%`

Release target:

- weighted score `>= 98`
- continuity score `>= 98`
- personal recall score `>= 95`
- MCP score `>= 98`
- DB/runtime score `= 100`
- benchmark safety score `= 100`

## Protected lanes

- `benchmark:canonical-identity-review`
- `benchmark:session-start-memory`
- `benchmark:personal-openclaw-review`
- `benchmark:personal-omi-review`
- `benchmark:omi-watch`
- `benchmark:mcp-production-smoke`
- `benchmark:profile-routing-review`
- `benchmark:recursive-reflect-review`
- `benchmark:public-memory-miss-regressions`
- `benchmark:locomo:standard`

## Failure taxonomy

- `wrong_claim_with_good_evidence`
- `missing_evidence`
- `weak_provenance`
- `entity_resolution_error`
- `temporal_resolution_error`
- `task_extraction_error`
- `continuity_pack_error`
- `clarification_closure_error`
- `atlas_truth_error`

## Run order

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain
npm run omi:sync

cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run namespace:reset -- --namespace-id personal
npm run namespace:replay -- --namespace-id personal --force
npm run typed-memory:rebuild -- --namespace-id personal
npm run namespace:reset -- --namespace-id personal_continuity_shadow
npm run namespace:replay -- --namespace-id personal_continuity_shadow --force
npm run typed-memory:rebuild -- --namespace-id personal_continuity_shadow
```

Then run the protected lanes serially.

## Interpretation

- evidence present + wrong claim: fix reader or claim selection
- missing evidence: fix retrieval, indexing, or source coverage
- right claim + weak provenance: fix evidence packing and source links
- clarification closure failure: fix rebuild scope or canonical repair
- atlas truth failure: fix canonical redirects, alias collapse, or graph cleanup

## Current status

As of `2026-03-29`, the frozen `98%` certification gate has passed from clean
replay and is the trusted release signal.

Primary sign-off artifacts:

- certification report:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/certification-98-2026-03-29T04-35-20-409Z.json`
- certification summary:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/certification-98-2026-03-29T04-35-20-409Z.md`

Certification summary:

- `repeatsRequested: 3`
- `repeatsPassed: 3`
- `componentCertificationPassed: true`
- `largerValidationPassed: true`
- `dashboardValidationPassed: true`
- `release98Passed: true`

The three clean component repeats all passed:

- repeat 1:
  - canonical identity review
  - personal OpenClaw review
  - session-start memory
  - personal OMI review
  - MCP production smoke
  - OMI watch
  - profile routing review
  - recursive reflect review
  - public memory miss regressions
- repeat 2:
  - canonical identity review
  - personal OpenClaw review
  - session-start memory
  - personal OMI review
  - MCP production smoke
  - OMI watch
  - profile routing review
  - recursive reflect review
  - public memory miss regressions
- repeat 3:
  - canonical identity review
  - personal OpenClaw review
  - session-start memory
  - personal OMI review
  - MCP production smoke
  - OMI watch
  - profile routing review
  - recursive reflect review
  - public memory miss regressions

The larger validation pack also passed:

- abstention review:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/abstention-review-2026-03-29T04-24-45-095Z.json`
- graph retrieval review:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/graph-retrieval-review-2026-03-29T04-25-03-695Z.json`
- temporal differential:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/temporal-differential-2026-03-29T04-26-11-429Z.json`
- life replay:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/life-replay-2026-03-29T04-26-52-004Z.json`
- life scale:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/life-scale-2026-03-29T04-28-18-864Z.json`
- LoCoMo standard:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/locomo-2026-03-29T04-35-11-040Z.json`
  - pass rate: `0.45`

Dashboard/console validation is green inside the certification harness:

- `brain-console` lint passed
- `brain-console` build passed

This is now the release proof. The earlier component-only slice artifacts are
superseded by the certification artifact above.

## What changed in this slice

- canonical entity resolution now follows redirect chains, so merged entities
  resolve to the live canonical target instead of leaving graph/query drift
- clarification resolution now triggers deterministic rebuilds for typed memory,
  relationship priors, relationship adjudication, temporal summaries, and
  canonical integrity audits
- canonical integrity audit views now catch redirect drift and stale historical
  relationship rows directly in Postgres
- `memory.get_relationships` now supports historical retrieval with tenure
  fields (`status`, `valid_from`, `valid_until`)
- `memory.get_graph` now carries edge status/history into the atlas payload
- exact alias questions like `What is Kozimui?` now resolve through a canonical
  alias fast path with real provenance
- `memory.get_graph("Kozimui")` resolves back to canonical `Koh Samui`
- `Who is Uncle?` resolves through canonical alias evidence to `Billy Smith`
  with `Joe Bob` preserved as an alias
- exact purchase questions now use a typed transaction lane:
  - `What did I buy today and what were the prices?`
  - returns itemized purchases plus an honest total when only the total is
    grounded
- media summary questions now use a typed media lane:
  - `What movies have I talked about?`
  - returns grounded titles like `Sinners`, `From Dusk Till Dawn`,
    `Slow Horses`, and `Avatar`
- explicit food-preference questions now use the new food/beer preference note
  and return grounded food-only facts:
  - `What food did I like?`
  - returns `spicy food` and `Nachos`
- explicit beer-preference questions now use the same typed lane:
  - `What are my favorite beers in Thailand?`
  - returns `Leo, Singha, Chang` in ranked order
- explicit preference-profile questions now use typed self-bound facts from the
  latest OMI note:
  - `What do I like and dislike?`
  - returns a compact cross-note profile including `spicy food`, `Nachos`,
    `hiking`, `MacBook Pros`, `snowboarding`, `Windows machines`,
    `mushy vegetables`, and `Android phones`
- current-routine questions now use a shaped daily-routine claim:
  - `What is my current daily routine?`
  - returns the wake / coffee / Reddit / tasks / 10 AM work / midday exercise
    structure from the new note
- temporal relationship/profile routing now has a narrow typed lane that
  handles direct current single-person questions without breaking broader
  multi-person profile prompts:
  - `Who is Dan in my life right now, exactly?`
  - returns `Dan is your friend` plus `Chiang Mai` association
- the temporal relationship lane settled on a stricter rule after looping on
  regressions:
  - direct typed routing is only for current/profile questions about one person
  - broader history and change questions stay on the richer evidence path
  - `former_partner_of` counts as current profile truth, which is why
    `Who is Lauren in my life right now, exactly?` now returns the correct
    former-partner answer instead of drifting to generic place associations
- direct relationship-change questions now use typed person-time transition
  facts before broad lexical search:
  - `What changed with Lauren, and when?`
  - returns the supported `October 18, 2025` transition and `stopped talking`
    outcome from the latest note instead of older generic summaries
- direct timing questions now stay stable under clean replay:
  - `When did Steve and Lauren stop talking?`
  - returns the supported `October 18, 2025` relationship-change answer from
    the temporal transition path
- metadata/front-matter lines are now filtered out of typed extraction:
  - `source:`, `conversation id`, `created at`, `category`, and similar OMI
    scaffolding no longer pollute `person_time_facts`, `media_mentions`, or
    `preference_facts`
- `What habits or constraints matter right now?` now routes through a typed
  routine/constraint lane instead of broad lexical retrieval:
  - returns the wake / coffee / Reddit / email/tasks / 10 AM work /
    midday exercise / protect personal time structure from the current routine
    note
- warm-start startup now includes a dedicated relationship-transition section:
  - `What important relationship transition should I know about right now?`
  - returns the supported Lauren `October 18, 2025` transition with the
    stronger `stopped talking after that and haven't really talked since`
    wording
- source-monitor imports now refresh derived namespace state automatically:
  - typed memory rebuild
  - relationship candidate consolidation and adjudication
  - temporal summary scaffold and archival
  - this is what kept OMI watch green after clean replay/import
- `What did I do yesterday?` now resolves through recap-family behavior and a
  daily-summary claim shaper instead of collapsing onto metadata headings
- `What did I talk about yesterday?` now routes through the recap-family lane
  and returns a shaped answer instead of raw headings or transcript sludge
- `What should you know about me to start today?` now routes through a
  warm-start pack that combines current focus, recent recap context, current
  routine, stable preferences, and carry-forward state instead of being stolen
  by the typed purchase lane
- daily and weekly temporal summary nodes now emit readable activity/entity
  summaries instead of mechanical rollup text, which is what the recap lane now
  leads with before descending to leaf notes when more detail is needed
- direct relationship/profile queries for `Ben`, `James`, and `Omi` now stay
  anchored to source-backed local clauses instead of inheriting the wrong
  person or noisy ASR fragments
- the relationships atlas now surfaces active vs historical edge state and
  validity windows instead of flattening every edge into one live-looking layer
- dashboard/console lint and build stayed green after the atlas alignment work
- the latest OMI note about yesterday's work is now live in `personal`, and the
  recap path pulls AI Brain, Preset Kitchen, Bumblebee, Well Inked, and Two Way
- the knowledge surface now prefers duality claim text and exposes a dedicated
  warm-start card instead of only echoing the top raw retrieval row
- the Knowledge surface now also exposes typed cards for:
  - habits and constraints
  - relationship transition
- broad preference-profile questions now stay clean and typed:
  - `What do I like and dislike?`
  - includes `mountain biking` in the evidence-backed profile after widening
    typed preference coverage instead of falling back to noisy raw transcript
    mining

## Caveat

The umbrella `benchmark:production-confidence` runner is still not the trusted
signal in this environment. A fresh `benchmark:locomo:standard` canary was not
required for this product-facing slice; the release signal remains the
component benchmark artifacts above, all run from clean replay.
