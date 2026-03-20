# Brain 2.0 Phase Roadmap

This document tracks the phased implementation plan for expanding the life
ontology without destabilizing retrieval quality.

Each phase follows the same loop:

1. make the schema/routing change
2. wipe the local database
3. replay the saved corpus
4. run the fresh replay benchmark
5. self-heal failures before moving on

Research guidance for sequencing:

- stabilize substrate before adding cognitive complexity
- expand daily-life event handling before higher abstractions
- add contradiction and supersession regressions before richer plans/goals
- defer emotion, routines, and life-phase abstraction until replay is stable

## Phase 1: Substrate Hardening

### Goal

Strengthen the existing tripartite substrate so daily-life notes and changing
truth can be replayed safely.

### Scope

- keep `relationship_memory` and `procedural_memory` temporally valid
- keep assertion vs accepted truth separation intact
- keep hierarchy authoritative on `entities.parent_entity_id`
- keep clarification-driven rebuild deterministic

### Entry Criteria

- life replay benchmark passes on the current saved corpus
- self profile and clarification flows exist

### Done Criteria

- replay remains green after schema/routing changes
- current truth outranks historical truth for “right now” questions
- historical truth remains queryable

### Replay Tests

- `where does Steve live?`
- `where has Steve lived?`
- `where has Steve worked?`
- current home state
- temporal nodes exist

## Phase 2: Daily-Life Event Coverage

### Status

- in progress
- clean replay is green with event fixtures and event-oriented query regression
- current verified event queries:
  - `who did Steve have dinner with?`
  - `where did Steve go coworking?`
  - `what happened at Yellow co-working space?`
  - `what happened during dinner with Dan?`
- current verified broader event-summary query:
  - `what did Steve do on March 20 2026?`
- current verified graph expansion:
  - focusing `Steve Tietze` expands into related event nodes and connected people/projects/places such as `Dinner with Dan at Chiang Mai`, `Yellow co-working space`, `Dan`, and `Two-Way`
- current remaining gap:
  - looser relative-day prompts like `what did Steve do today?` still need stronger anchoring to the most relevant day/session slice

### Goal

Widen the ontology/test corpus so mixed life notes produce multiple usable
events rather than only loose fragments.

### Scope

- coworking
- meals
- massage
- rides
- short travel notes
- who/where/when participation

### Entry Criteria

- Phase 1 is green

### Done Criteria

- one daily-life note can split into multiple narrative events
- events keep participant and place links
- replay verifies event generation from a clean DB

### Replay Tests

- event count/state assertions for daily-life fixtures
- query/evidence checks as event retrieval improves
- `who did Steve have dinner with?`
- `where did Steve go coworking?`

## Phase 3: Contradiction And Supersession

### Status

- in progress
- clean replay is green for preference supersession, current vs historical home, and historical work-role pollution guards
- current verified state guards:
  - historical `project_role` rows from resume/timeline notes do not remain active
  - historical employers do not leak into active affiliations
  - preference drift now supports current, historical, and point-in-time recall for explicit tenure chains
  - `switched from X to Y` now closes the old preference truth and promotes the new one deterministically

### Goal

Prove that changing truth does not pollute current state.

### Scope

- preference changes
- residence changes
- work/project transitions
- list mutation where supported

### Entry Criteria

- daily-life replay remains green

### Done Criteria

- old truth remains as evidence/history
- new truth becomes the only active procedural row
- superseded rows have closed validity windows

### Replay Tests

- active preference state checks
- superseded prior state checks
- current vs historical preference queries
- point-in-time preference queries
- current vs historical home checks
- current vs historical employer/project checks

## Phase 4: Typed Ontology Expansion

### Status

- in progress
- clean replay is green for the first typed-entity slice:
  - `activity`
  - `media`
  - `skill`
  - `decision`
  - `constraint`
  - `style_spec`
  - `goal`
  - `plan`
  - `belief`
  - current verified additions:
  - `Snowboarding` and `Hiking` are first-class `activity` entities
  - favorite movies and watchlist items are first-class `media` entities
  - explicit capability evidence now promotes first-class `skill` entities like `Full-Stack Web Development`, `Photogrammetry`, and `Stable Diffusion`
  - explicit durable choices now promote first-class `decision` entities like `Stay in Thailand long term` and `Keep Brain 2.0 on Postgres`
  - explicit operating rules now promote first-class `constraint` entities like `Return Ground-Truth Source Document With Search Results` and `Ask For Clarification Instead Of Guessing`
  - explicit work-style and response-style directives now promote first-class `style_spec` entities like `Keep Responses Concise`, `Review Ontology Changes Carefully`, `Wipe And Replay The Database After Each Slice`, and `Prefer Natural-Language Queryability`
  - explicit goal and plan statements now promote first-class `goal` and `plan` entities like `Stay in Thailand` and `Attend conference in Turkey for Two-Way`
  - explicit stance and opinion evidence now promotes first-class `belief` entities with historical supersession for infrastructure views
  - natural queries still pass after the typed expansion
  - latest clean replay report:
    - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/life-replay-2026-03-20T04-43-04-642Z.json`

### Goal

Move beyond the broad `concept` bucket where it materially improves retrieval.

### Scope

- `media`
- `activity`
- `skill`
- `decision`
- `constraint`
- `style_spec`
- `goal`
- `plan`
- `belief`

### Next Conservative Order

1. `activity`
2. `media`
3. `skill`
4. `decision`
5. `constraint`
6. `style_spec`
7. `goal`
8. `plan`
9. `belief`

### Entry Criteria

- contradiction/supersession replay is green

### Done Criteria

- typed entities do not reduce natural-language query quality
- retrieval can still return evidence-first answers
- typed entities are created on clean replay and remain grounded in source evidence

### Replay Tests

- movies/watchlist
- activities like snowboarding/hiking
- explicit skills from work-history and autobiographical notes
- explicit decisions and operational constraints
- style and work-preference fixtures
- goal / plan fixtures
- belief evolution fixtures

## Phase 5: Relational Hardening

### Status

- in progress
- clean replay is green for the first relational-hardening batches:
  - romantic current-vs-history separation using `significant_other_of`
  - exclusive self `works_at` promotion into `current_employer`
  - active home tenure edges standardized onto `resides_at`
  - thresholded `member_of` promotion after repeated participation
- current verified additions:
  - `who was Steve dating?` returns historical relationship truth
  - `who is Steve dating now?` does not leak superseded history
  - `where does Steve work?` returns the current employer
  - `where does Steve live?` is backed by an active `resides_at` edge plus anchored procedural truth
  - `what groups is Steve a member of?` only resolves after three participation sessions
  - provenance-first `why does the brain believe X?` queries now return active fact answers plus evidence bundles for employer and home truth
  - reconsolidated day-summary answers now survive the full lexical merge path and become confident after replay-triggered reconsolidation
  - formal relational supersession for `resides_at` and `works_at` is now replay-verified with closed tenure chains and `superseded_by_id` links
  - duality response contract is now standardized as `duality_v2` with graded follow-up actions for confident, weak, and missing answers
  - expected abstentions now return a non-hallucinated duality object and route clients toward clarification instead of silent null behavior
  - replay now enforces formal tenure checks for:
    - one active `works_at` edge for the current employer
    - historical `worked_at` rows for prior employers
    - one active `resides_at` edge for the current home
    - closed `works_at` and `resides_at` tenures for prior current states
  - duality-object response and confidence grading are now part of the replay contract
  - hierarchy-aware recall descent is now deterministic for temporal questions:
    - broad temporal summaries can stop at summary support when sufficiency is strong
    - detail-seeking temporal queries must descend to direct leaf evidence
    - exact dated detail queries like `how much did coworking cost on March 20 2026?` are replay-verified
  - broader contradiction healing now covers explicit preference drift:
    - `what does Steve prefer now for coffee?`
    - `what did Steve use to prefer for coffee?`
    - `what did Steve prefer in 2024 for coffee?`
  - style/work-style truth is now replay-verified through first-class `style_spec` entities and procedural truth:
    - `what style specs does Steve have?`
    - `what is Steve's preferred response style?`
    - `what is the mandatory protocol for changing the brain's ontology?`
    - `what should be done with the database after each ontology slice?`
  - belief evolution is now replay-verified through a unified first-class `belief` class with current, historical, and point-in-time queries:
    - `what is Steve's current stance on infrastructure?`
    - `how has Steve's opinion on infrastructure changed since 2025?`
    - `did Steve still support hosted infrastructure in January 2025?`
  - salience-aware querying is now replay-verified with topic-first, emotion-second ranking:
    - `what was the most frustrating part of the local-brain bring-up?`
    - `what was Steve excited about with the graph UX?`
  - active romantic relationship truth can now be mirrored into procedural state on top of relationship tenure:
    - `who is Alex dating now?`
    - `who was Nina dating?`
    - active `current_relationship` state now exists for present-tense dating facts
    - superseded `current_relationship` state now closes when a breakup arrives later
  - current-dating abstention is now stronger and evidence-backed:
    - `who is Steve dating now?` returns a confident duality claim of `Unknown.`
    - `who is Nina dating now?` returns a confident duality claim of `Unknown.`
    - direct breakup or paused-contact evidence is now sufficient to prove the absence of an active partner without hallucinating a new one
  - romantic tenure transitions are now replay-verified:
    - paused or ended contact closes the active romantic tenure and closes `current_relationship`
    - reconnect reopens a new active romantic tenure when the evidence is temporally separable
    - dense autobiographical notes that collapse dating, breakup, and reconnection onto the same timestamp are now kept as historical evidence instead of forcing fake active tenure
  - conflict-aware reconsolidation now covers relationship profile summaries:
    - stale relationship profile summaries are superseded deterministically when newer tenure evidence changes state
    - replay proves this with a seeded stale Nina profile summary that heals to `Unknown`
  - historical work-history queries still return broad timeline coverage
  - multimodal-native derivation is now replay-verified through a conservative OCR vertical slice:
    - `what was written on the whiteboard photo from the March redesign packet?`
    - durable `artifact_derivations` rows are created from `derivation_jobs`
    - multimodal answers now return direct evidence instead of relying on text-only proxies
  - procedural heuristic induction is now replay-verified for one recurrence-gated operational rule:
    - repeated replay-integrity evidence across three distinct days promotes `Wipe And Replay The Database After Each Slice`
    - the active workflow rule carries induction metadata and supporting memory IDs
    - `what is the mandatory protocol for maintaining database integrity after an implementation slice?`
  - latest clean replay report:
    - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/life-replay-2026-03-20T05-59-19-839Z.json`
  - current confidence snapshot:
    - `50 confident`
    - `1 weak`
    - `0 missing`
  - current known weak cases:
    - pre-reconsolidation day-summary check for `what did Steve do on March 20 2026?`

### Goal

Move the relationship graph from flat connectivity to versioned social and work
tenures.

### Next Ranked Slices

1. broader contradiction healing beyond preferences and beliefs
2. clarification-triggered memory gap tickets for truly missing facts
3. complexity-aware hierarchical descent and sufficiency gating beyond the current temporal stack

### Scope

- temporal validity on edges
- stronger relationship typing
- clearer current-vs-historical relationship state
- provenance-first relationship queries

### Entry Criteria

- Phase 4 replay remains green

### Done Criteria

- current relationship state excludes superseded historical state
- historical relationship questions can time-filter correctly
- relationship answers return evidence bundles
- replay surfaces `weak` answers separately from `confident` answers

### Replay Tests

- `who was Steve dating in 2024?`
- `who is Steve dating now?`
- `who is Nina dating now?`
- `where does Steve work?`
- `where does Steve live now?` still returns one active home
- `what groups is Steve a member of?`
- `why does the brain believe Steve works at X?`
- stale relationship profile summaries are superseded when newer tenure evidence changes the active state
- active `resides_at` edge exists for the current home
- active `works_at` edge exists for the current employer
- historical `worked_at` rows remain queryable for prior employers

### Next Ranked Slices

1. additional group-membership edge cases as corpus expands
2. deeper relationship transition queries with more time-bounded status coverage
3. relationship-aware profile summaries beyond the current romantic-status slice

## Phase 6: Higher Abstractions

### Status

- in progress
- clean replay is green for the first higher-abstraction slice:
  - `routine`
  - `goal`
  - `plan`
  - `belief`
  - current verified additions:
  - weekly repeated coworking now promotes a first-class `routine`
  - explicit goal, plan, and belief abstractions now remain evidence-backed after replay
  - routine answers remain evidence-backed after replay
  - multimodal OCR derivations now survive replay and are queryable through the same duality contract as text-native memory
  - one deterministic operational heuristic now survives replay with a hard recurrence gate instead of a one-off directive promotion
  - event-bounded retrieval now returns richer event context plus evidence bundles without overriding stronger graph truth
  - sufficiency-gated temporal descent is now active in replay with weak-vs-confident grading instead of pass/fail only
  - structured salience annotation is now replay-verified on episodic and narrative memory without promoting emotion into active truth
  - conflict-aware reconsolidation is now replay-verified for:
    - `day_summary`
    - relationship `profile_summary`
  - existing ontology queries still pass after the new abstraction
  - latest clean replay report:
    - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/life-replay-2026-03-20T05-59-19-839Z.json`

### Goal

Add richer planning and autobiographical abstractions only after the substrate is
stable.

### Scope

- routines
- emotion annotation
- life phases
- decisions/beliefs/principles
- goals
- plans

### Entry Criteria

- all earlier phases replay cleanly

### Done Criteria

- abstractions stay grounded in evidence
- they do not replace current truth or raw history

### Replay Tests

- phase summaries
- contradiction-safe emotional/source annotations
- evidence-backed plan/goal retrieval
- evidence-backed belief retrieval and historical belief drift
- `what routines does Steve have?`

### Next Ranked Slices

1. broader contradiction healing beyond preferences and beliefs
2. smarter recall-planner gating by query complexity
3. extend procedural heuristic induction beyond replay integrity into one more machine-enforceable workflow rule
4. richer life-phase annotation after the above stays replay-green

## Phase Gates

Do not move to the next phase until:

- `npm run benchmark:life` passes on a wiped DB replay
- new fixtures are committed
- new failure modes are documented
- the current phase updates this roadmap with status notes
