# Fresh Replay Regression

The replay suite proves that wiping the database and re-ingesting the same
source corpus reconstructs the same life graph and active truth.

## What Each Run Must Do

1. Truncate all public tables except `schema_migrations`.
2. Re-ingest the saved source corpus.
3. Run relationship adjudication.
4. Run candidate consolidation.
5. Regenerate temporal summaries.
6. Execute natural-language query assertions.
7. Execute graph/current-truth assertions.
8. Grade every natural-language query as `confident`, `weak`, or `missing`.
9. Verify every query returns evidence with source provenance.

## Confidence Contract

- `confident`
  - the answer is semantically right
  - the top claim is directly grounded in replayed source evidence
  - provenance resolves back to a real artifact or memory row
  - reconsolidated semantic summaries are allowed if they retain direct evidence pointers and the response includes the supporting evidence bundle
- `weak`
  - the answer is grounded, but only through summary-level or indirect support
  - or the query is an expected abstention with no active result
- `missing`
  - the answer is absent, contradictory, hallucinated, or lacks provenance support

## Core Query Checks

- `where was Steve born?`
- `where does Steve live?`
- `where has Steve lived?`
- `where has Steve worked?`
- `what did Steve do at Factor 5?`
- `who are Steve's friends?`
- `where did Lauren live?`
- `what is Steve working on?`
- `what movies does Steve like?`
- `what does Steve want to watch?`
- `what does Steve prefer now for coffee?`
- `what did Steve use to prefer for coffee?`
- `what did Steve prefer in 2024 for coffee?`
- `what happened at Yellow co-working space?`
- `what happened during dinner with Dan?`
- `what did Steve do on March 20 2026?`
- `how much did coworking cost on March 20 2026?`
- `why does the brain believe Steve works at Two-Way?`
- `why does the brain believe Steve lives in Chiang Mai?`
- `what style specs does Steve have?`
- `what is Steve's preferred response style?`
- `what is the mandatory protocol for changing the brain's ontology?`
- `what should be done with the database after each ontology slice?`
- `what is the mandatory protocol for maintaining database integrity after an implementation slice?`
- `what is Steve's current stance on infrastructure?`
- `how has Steve's opinion on infrastructure changed since 2025?`
- `did Steve still support hosted infrastructure in January 2025?`
- `who is Steve dating now?`
- `who is Alex dating now?`
- `who was Nina dating?`
- `who is Nina dating now?`
- `what are my absolute dietary blockers for tonight's dinner?`
- `what is my current stance on using Python for high-concurrency jobs?`
- `how has my opinion on Python for high-concurrency jobs changed?`
- `why did we decide to use a unified Postgres substrate instead of a dedicated vector database?`
- `what is the mandatory protocol for handling large PDF uploads in this substrate?`
- `what was written on the whiteboard photo from the March redesign packet?`
- `what did the March redesign packet say about the Steve graph?`
- `what did the Chiang Mai graph voice memo say?`
- `what country is Chiang Mai in?`
- `where in the hierarchy is Tahoe City?`
- `what constraint should the brain follow when identity is unclear?`
- `who is Uncle?`

## Core State Checks

- active home is the most specific current residence
- old employers are `worked_at`, not `works_at`
- exactly one active `works_at` edge exists for the current employer
- historical `worked_at` rows survive replay
- temporal nodes regenerate after clarification rebuilds
- identity merges survive replay
- evidence bundle is present on query responses
- claim-plus-evidence duality object is present on evidence-backed query responses
- event-bounded answers preserve source-evidence bundles
- recurrence-gated operational heuristics survive replay with induction metadata
- focused graph expansion for the self anchor includes connected event nodes and related people/projects/places
- direct breakup or paused-contact evidence can justify a confident current-state abstention as `Unknown.`
- stale relationship profile summaries are superseded by reconsolidation when active tenure state changes
- unresolved kinship placeholders route to clarifications instead of returning guessed identities
- unresolved vague-place placeholders route to clarifications instead of returning guessed grounding
- belief-summary reconsolidation supersedes stale summaries after explicit state changes
- deterministic multimodal derivation jobs complete and persist replay-safe `artifact_derivations`
- hierarchy lookup queries can stop at structural `parent_entity_id` facts without forcing noisy episodic descent
- generalized heuristic induction can promote reusable `constraint` truth, not just `style_spec`

## Output

Each run should write:

- JSON report with pass/fail details
- confidence grade and reason for each natural-language query
- Markdown report for quick operator review
- latest symlink-style copies for the most recent run

Current green reference run:

- clean replay:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/life-replay-2026-03-20T08-17-33-725Z.json`
- scale replay:
  - `/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/benchmark-results/life-scale-2026-03-20T08-17-47-452Z.json`

## Scale Replay Addendum

The scale harness should:

1. run the clean replay benchmark first for the current baseline
2. wipe the database again
3. ingest the canonical corpus plus deterministic medium / large / noisy generated artifacts
4. rerun adjudication, consolidation, and temporal summaries
5. execute a smaller natural-language scale query pack with latency reporting
6. execute Steve-focused graph stress checks
7. report clarification counts by ambiguity type

Current scale assertions:

- no quality delta on the scale query pack versus the clean baseline pack
- `who is Uncle?` routes to clarifications instead of hallucinating
- `where was the summer cabin?` routes to clarifications instead of hallucinating
- Steve-focused scale graph remains provenance-backed and does not collapse under the noisier corpus
