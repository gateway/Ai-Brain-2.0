# Narrative Benchmark And Project Loop

Date: 2026-03-18

## Goal

Tighten the freeform narrative path so the same ingestion model can handle:

- personal story / friend graph memory
- project/spec updates
- preference changes
- negative-control prose without junk entity promotion

## NotebookLM Loop

NotebookLM was used as a second-brain check for two questions:

1. smallest safe RelPrior-style binary relation prior
2. concrete benchmark matrix for freeform story + project update ingestion

What survived cross-checking:

- use a lightweight prior before relationship promotion
- keep it deterministic and SQL/runtime-native
- do not overbuild a second graph system yet
- benchmark should explicitly cover aliases, event grouping, project truth, supersession, temporal handling, and negative controls

What was rejected:

- adding a full new `relationship_priors` subsystem right now
- making the prior an LLM-dependent gate
- pretending fuzzy embedding similarity is an acceptable relationship edge source

## Worker Takeaways

Four workers were used in parallel.

- relation-prior review:
  - keep the prior lightweight
  - score candidates using scene/event/role/time evidence
  - use it as a promotion hint, not a separate graph
- multi-scene consolidation review:
  - merge only inside the same artifact observation
  - require at least two matching anchors
  - keep scene provenance intact
- narrative benchmark review:
  - add a dedicated golden-story harness
  - validate graph edges, current truth, and negative controls
- project/spec path review:
  - reuse `claim_candidates`
  - promote project current truth into `procedural_memory`
  - do not create a redundant project-state table yet

## Implementation

Added:

- migration:
  - `local-brain/migrations/017_narrative_quality_and_project_claims.sql`
- narrative runtime:
  - relation-prior scoring on `claim_candidates` and `relationship_candidates`
  - conservative multi-scene event clustering
  - project-status / project-deadline / project-spec / project-role claim extraction
- consolidation runtime:
  - deterministic promotion of project claims into `procedural_memory`
- benchmark harness:
  - `local-brain/src/benchmark/narrative-cases.ts`
  - `local-brain/src/benchmark/narrative-quality.ts`
  - `local-brain/src/cli/benchmark-narrative.ts`
  - `local-brain/examples/golden-stories/*`

## Verified Results

`npm run check`

- passed

`npm run benchmark:narrative`

- passed `4/4`
- cases:
  - `negative_control_no_people`
  - `personal_story_relationships`
  - `preference_supersession`
  - `project_state_and_spec`

Latest narrative benchmark artifacts:

- `local-brain/benchmark-results/narrative-latest.json`
- `local-brain/benchmark-results/narrative-latest.md`

## Freeform Story Re-Run

The original Steve / Chiang Mai / Lauren / Dan / Gumi / Ben / Rafa / Renee story was re-ingested into a fresh namespace after the fixes.

Materially correct outputs now include:

- `Steve -> friend_of -> Lauren`
- `Steve -> friend_of -> Gumi`
- `Dan -> from -> Mexico City`
- `Gumi -> runs -> Two Way`
- `Gumi -> works_at -> Icelandic Air`
- `Steve -> works_at -> Two Way`
- `Steve -> works_at -> Well Inked`
- `Steve -> works_with -> Benjamin Williams`
- `Renee -> currently_in -> Danang`

Project-role current truth produced from that story:

- `two_way:steve -> CTO`
- `well_inked:steve -> a fractional CTO`
- `icelandic_air:gumi -> airline_pilot`

## Self Review

What went well:

- the weak point was correctly identified as transformation, not user input style
- the narrative harness now protects the path we actually care about
- project/spec memory is now on the same event-aware path instead of being a side note

What is still not done:

- place containment is still flat (`Chiang Mai` and `Thailand` can both remain active facts)
- relative-time normalization is still basic
- the old lexical/TMT eval failures are still separate backlog items
- BM25 closure is still a separate lexical track from this narrative/project slice

Confidence after this pass:

- freeform personal-story ingestion path: `~98%`
- deterministic implementation quality on stories like the Steve/Lauren/Gumi/Ben narrative: `~95%`
- project/spec current-truth promotion path: `~93%`

## Next Best Move

If continuing this narrative line, the best next moves are:

1. place hierarchy / containment
2. stronger relative-time normalization
3. apply the same golden-story harness to side-project / shared-project collaboration stories
