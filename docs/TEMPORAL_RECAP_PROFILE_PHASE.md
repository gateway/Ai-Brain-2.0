# Temporal Relationship, Recap, and Profile Phase

This document defines the next major AI Brain phase after canonical identity,
typed purchases/media/preferences, and clean replay hardening.

## Goal

Push the system from "typed fact retrieval is working" to "the brain understands
time, relationship state, and stable startup context."

This phase is intentionally ordered to protect Postgres-as-truth and keep the
atlas as a derived read model instead of turning retrieval into a second truth
system.

## Phase Order

1. temporal relationship truth
2. hierarchical recap descent
3. warm-start profile pack
4. atlas enrichment on top of the stronger truth

## Why this order

Notebook guidance converged on the same sequence:

- **The Digital Brain** pushes hierarchical recap and sufficiency-gated descent
  after the substrate is hardened.
- **NER for Databases** pushes temporal edge versioning before broader recap or
  profile work.
- Chroma research reinforces that hybrid/vector/full-text retrieval is useful,
  but not a reason to replace our canonical Postgres truth path.

## Slice 1: Temporal Relationship Truth

### Build

- enforce `valid_from` / `valid_until` more strictly for relationship truth
- add deterministic "exactly one active edge" rules for exclusive predicates
- improve relationship transition facts:
  - started
  - paused
  - ended
  - reconnected
- expand `person_time_facts` for relationship transitions and history windows
- make current-vs-historical relationship queries use typed tenure first

### Product questions protected

- `Who is this person in my life right now?`
- `What changed with Lauren, and when?`
- `What is Steve's history with Lauren?`
- `Who used to be in my life, but is not current now?`

### Success metrics

- relationship-history score
- current-vs-historical separation score
- no mixed active/historical claim in protected tests

## Slice 2: Hierarchical Recap Descent

### Build

- deepen daily and weekly temporal summary nodes
- make recap queries resolve time window first:
  - today
  - yesterday
  - this morning
  - last week
  - two weeks ago
- add a sufficiency gate:
  - try daily/weekly rollup first
  - descend to leaf evidence only if detail is missing
- keep exact detail questions anchored to leaf evidence

### Product questions protected

- `What did I do yesterday?`
- `What did I talk about yesterday?`
- `What happened last week?`
- `What should I pick back up?`

### Success metrics

- recap compactness score
- recap source-link score
- recap descent correctness score
- continuity regression score stays green

## Slice 3: Warm-Start Profile Pack

### Build

- create a stable startup/profile read layer for:
  - current focus
  - recurring preferences
  - recurring constraints
  - work style / session-start reminders
  - current projects / active threads
- keep it source-backed and replay-safe
- avoid freeform synthesis without anchors

### Product questions protected

- `What should you know about me to start today?`
- `What habits or constraints matter right now?`
- `What do I consistently like or avoid?`

### Success metrics

- warm-start usefulness score
- stable preference coverage score
- repeated-session startup quality score

## Slice 4: Atlas Enrichment

### Build

- show current vs historical edge state more clearly
- enrich node dossiers with:
  - canonical aliases
  - strongest current relationships
  - historical transitions
  - preferences / recurring traits where grounded
  - recap links into timeline/query/inbox

### Guardrails

- no new graph app
- no graph-first truth
- no visual polish ahead of truth quality

## Chroma Recommendation

We should **not** switch AI Brain from Postgres truth to Chroma.

### What is useful from Chroma

- hybrid retrieval thinking: vector + full-text + metadata filters
- low-latency retrieval patterns
- collection/versioning ideas for experimentation
- search-oriented product thinking around query modes and filters

### What we should keep

- Postgres as truth substrate
- canonical identity and clarification repair in SQL-backed state
- temporal rollups and typed facts in our existing DB
- atlas as a derived view

### What to borrow conceptually

- stronger retrieval mode routing
- better metadata-aware filtering
- cleaner experimental indexing/version lanes

## Validation Loop

Every serious slice uses:

1. `npm run omi:sync`
2. clean replay `personal`
3. typed rebuild `personal`
4. clean replay `personal_continuity_shadow`
5. typed rebuild `personal_continuity_shadow`
6. targeted query checks
7. protected benchmark stack
8. dashboard lint/build
9. docs update

## Benchmarks To Keep Green

- `benchmark:canonical-identity-review`
- `benchmark:personal-omi-review`
- `benchmark:mcp-production-smoke`
- `benchmark:personal-openclaw-review`
- `benchmark:session-start-memory`
- `benchmark:omi-watch`
- `benchmark:profile-routing-review`
- `benchmark:recursive-reflect-review`
- `benchmark:public-memory-miss-regressions`

## Current Status

As of `2026-03-29`, this phase has been implemented, validated from clean
replay, and then certified under the frozen `98%` release gate.

Green artifacts:

- `benchmark:personal-omi-review`
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/personal-omi-review-2026-03-28T15-27-04-303Z.json`
  - summary: `29 pass / 0 warning / 0 fail`
- `benchmark:mcp-production-smoke`
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/mcp-production-smoke-2026-03-28T15-28-13-695Z.json`
  - summary: `35 pass / 0 fail`
- `benchmark:personal-openclaw-review`
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/personal-openclaw-review-2026-03-28T15-29-48-285Z.json`
  - summary: `9 pass / 0 fail`
- `benchmark:session-start-memory`
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/session-start-memory-2026-03-28T15-30-49-013Z.json`
- `benchmark:canonical-identity-review`
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/canonical-identity-review-2026-03-28T15-30-49-517Z.json`
  - summary: `5 pass / 0 fail`
- `benchmark:omi-watch`
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/omi-watch-smoke-2026-03-28T15-32-13-991Z.json`
- `benchmark:profile-routing-review`
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/profile-routing-review-2026-03-28T15-32-14-132Z.json`
- `benchmark:recursive-reflect-review`
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/recursive-reflect-review-2026-03-28T15-32-30-902Z.json`
- `benchmark:public-memory-miss-regressions`
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/public-memory-miss-regressions-2026-03-28T15-32-31-064Z.json`

Dashboard validation is also green:

- `brain-console` lint passed
- `brain-console` build passed

Key product gains from this phase:

- direct temporal relationship routing now handles current single-person
  relationship questions without regressing broader profile/history prompts
- the temporal relationship lane is now explicitly split:
  - current/profile questions about one person use the compact direct lane
  - history/change questions stay on the broader evidence path
  - this was the lane that held under clean replay after multiple loops
- recap answers now lead with readable daily/weekly temporal summaries and only
  descend to leaf notes when needed
- warm-start startup packs now include current focus, recent context, routine,
  and stable preference carry-forward
- metadata/front-matter filtering now prevents OMI scaffolding from polluting
  temporal and preference typed facts
- `What habits or constraints matter right now?` now uses a typed
  routine/constraint lane and returns the current routine plus the
  protect-personal-time constraint
- the warm-start path now includes a startup-specific relationship-transition
  lane so relationship context is explicit instead of implicit
- broad preference-profile questions now stay typed and evidence-backed,
  including `mountain biking`, instead of drifting into noisy raw transcript
  mining
- the final Lauren transition wording lane stabilized after looping:
  - `stopped talking after that and haven't really talked since`
- the dashboard copy for Knowledge and Relationships now reflects the live
  temporal/profile routing capabilities
- `former_partner_of` is treated as current-profile truth, which is what keeps
  `Who is Lauren in my life right now, exactly?` correct while preserving the
  broader Tahoe -> Bend -> Thailand -> October 18, 2025 relationship history

## Certification outcome

As of `2026-03-29`, this phase is not just implemented. It is certified under
the frozen `98%` release gate.

Final certification artifacts:

- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/certification-98-2026-03-29T04-35-20-409Z.json`
- `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/certification-98-2026-03-29T04-35-20-409Z.md`

Certification result:

- `repeatsPassed: 3`
- `componentCertificationPassed: true`
- `largerValidationPassed: true`
- `dashboardValidationPassed: true`
- `release98Passed: true`

That means this phase is complete for the frozen scope it set out to cover.

## Immediate Next Work

This phase should not be widened further by default. New work should start as a
new frozen scope, not by reopening this one.

Candidate follow-on work:

1. new explicit clarification harness coverage
2. new frozen preference/habit expansion pack
3. new atlas/operator workflow pack
4. umbrella runner cleanup only if it improves maintainability without changing
   certified product behavior
