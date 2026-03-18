# Query Runner And Qwen Validation Pass

Date: 2026-03-18

## Goal

Close a real user-facing gap:

- the graph showed `Steve -> lives_in -> Chiang Mai/Thailand`
- the normal query runner did not answer `where does Steve live?`

Also verify the real external Qwen classifier against saved friend-note fixtures.

## What Was Wrong

Two independent issues were present:

1. `relationship_memory` was not part of the main `/search` retrieval branch.
   - `searchMemory()` searched procedural, semantic, candidates, temporal summaries, episodic memory, and derivations.
   - It did not search active relationship memory.

2. The console Query page defaulted to `personal`, while the graph/timeline views defaulted to the shared latest-eval namespace.
   - This made the graph and query runner inspect different memory lanes by default.

## NotebookLM Guidance

NotebookLM confirmed the expected architecture:

- current-state person/place questions should route through active truth plus relationship joins
- lexical/episodic search alone is not sufficient
- relationship facts should be searchable in the same retrieval flow, not siloed behind a separate graph-only endpoint
- provenance must still point back to raw evidence

## Changes Made

### Retrieval

- Added `relationship_memory` as a first-class searchable `memoryType`.
- Added active relationship lexical search rows for both:
  - native FTS mode
  - BM25 mode through an FTS bridge
- Added active-relationship query detection for prompts like:
  - `where does Steve live?`
  - `where is Dan from?`
  - `who does Tim work with?`
  - `what does Dan do?`
- Added preferred predicate routing so present-tense residence questions prioritize:
  - `lives_in`
  - `currently_in`
  over historical:
  - `lived_in`

### Console

- Changed the Query page to use the shared console defaults instead of hard-coding `personal`.

### Benchmarks

- Added a lexical benchmark case:
  - `where does Steve live?`
- Seeded benchmark relationship rows for:
  - `Steve -> lives_in -> Chiang Mai`
  - `Steve -> lives_in -> Thailand`

### External Qwen Classifier

- Real external classification initially failed because provider ambiguity labels were more flexible than the database enum.
- Added ambiguity-type normalization so provider labels map safely into the allowed brain values:
  - `possible_misspelling`
  - `undefined_kinship`
  - `vague_place`
  - `alias_collision`
  - `unknown_reference`
  - `asr_correction`
  - `kinship_resolution`
  - `place_grounding`

## Verification

### Query Runner

Live runtime check:

- namespace: `personal_story_test`
- query: `where does Steve live?`

Result after fix:

- `relationship_memory`
- `Steve lives in Thailand`
- `relationship_memory`
- `Steve lives in Chiang Mai`

This replaced the previous behavior where the query runner only surfaced the raw episodic sentence.

### Lexical Benchmark

`npm run benchmark:lexical`

Result:

- `FTS 15/15`
- `BM25 15/15`
- new relationship case passes for both providers

### Console

- `brain-console` lint passed
- `brain-console` build passed

### External Qwen Classification

Test target:

- namespace: `qwen_personal_circle_live_20260318`
- source: `examples/live-personal-circle.md`
- provider: external Qwen 3.5 remote runtime

Inserted:

- entities: `10`
- relationships: `10`
- claims: `4`
- ambiguities: `2`
- memory candidates: `12`

Staged relationships included:

- `Steve -> friends_with -> Gumee`
- `Steve -> friends_with -> Ben`
- `Gumee -> friends_with -> Ben`
- `Dan -> originates_from -> Mexico City`
- `Dan -> holds_passport_from -> Australia`
- `Tim -> works_at -> Well Inked`
- `Tim -> best_friends_with -> Ben`

Staged ambiguities included:

- `Gumee` -> `possible_misspelling`
- `Well Inked` -> normalized to `unknown_reference`

## Remaining Follow-Ups

The query gap is fixed, but the next worthwhile improvements are:

1. Add relationship-memory search coverage for more active-truth questions:
   - `who are Steve's friends?`
   - `what project is Steve working on?`
   - `where is Dan from?`

2. Optionally mirror selected active relationship predicates into procedural/searchable state:
   - `lives_in`
   - `currently_in`
   - `works_at`
   - `works_on`

3. Tighten the provider classification ontology:
   - normalize predicates like `friends_with` vs `friend_of`
   - normalize `originates_from` vs `from`

4. Add a visible console hint showing the active namespace on every page.

5. Add an external-classifier regression harness over the saved personal/project fixtures.
