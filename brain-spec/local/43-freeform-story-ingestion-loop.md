# Freeform Story Ingestion Loop

## Goal

Make the brain ingest a natural first-person personal story without forcing the user to speak in a rigid structure, while keeping raw Markdown/transcript evidence as source of truth and producing a usable relationship graph.

## What Was Wrong

The problem was not the user's narrative style.

The failing layer was the transformation path between:

- raw artifact / episodic evidence
- structured entities / relationships / promoted memory

The old path relied too heavily on fragment-local heuristics:

- relationship edges were written too early
- pronouns and aliases were resolved too weakly
- organizations had no explicit entity lane
- adjudication aggressively superseded multiple valid relationship edges

That caused bad outputs like:

- `He` becoming a person node
- `Icelandic Air` becoming a person or being attached to the wrong subject
- `Ben` not resolving to `Benjamin Williams`
- `Danang` being superseded by `Vietnam`

## NotebookLM Cross-Check

NotebookLM strongly reinforced the same conclusion:

- regex-only extraction is the wrong long-term path for freeform narrative
- a `scene + claim` intermediate layer is the minimum correct architecture
- raw episodic evidence must remain immutable
- relationship promotion should happen after claim staging, not directly from raw fragments
- abstention is required when subject/object/time resolution is weak

The useful practical guidance I kept:

- segment freeform narrative into coherent scenes
- stage structured claims before promotion
- use an alias registry and coreference-aware promotion path
- preserve provenance all the way back to the raw artifact

## What Changed

### Schema

Added:

- [`015_narrative_scenes_and_claims.sql`](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/migrations/015_narrative_scenes_and_claims.sql)

This adds:

- `narrative_scenes`
- `claim_candidates`
- `org` as an explicit entity type
- nullable `source_scene_id` support on:
  - `memory_entity_mentions`
  - `relationship_candidates`
  - `memory_candidates`

### Runtime

Added:

- [`src/relationships/narrative.ts`](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/relationships/narrative.ts)

This now does:

- paragraph-to-scene segmentation
- deterministic scene-aware claim extraction
- self carryover across scenes
- cross-scene alias carryover
- safe abstention for future/weak claims
- relationship candidate generation from accepted claims
- employment/memory candidate staging from accepted claims

Updated:

- [`src/ingest/fragment.ts`](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/ingest/fragment.ts)
- [`src/ingest/worker.ts`](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/ingest/worker.ts)
- [`src/types.ts`](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/types.ts)

Key shift:

- the worker no longer depends on fragment-local relationship staging as the primary path
- it now writes scenes and then stages claims from scenes

### Adjudication

Updated:

- [`src/jobs/relationship-adjudication.ts`](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/jobs/relationship-adjudication.ts)

Important change:

- relationship adjudication no longer treats the current graph predicates as exclusive by default

That stopped valid multi-edge cases from getting incorrectly superseded:

- `Renee currently_in Danang`
- `Renee currently_in Vietnam`
- `Benjamin Williams lived_in France`
- `Benjamin Williams lived_in Singapore`

### Console

Updated:

- [`brain-console/src/components/relationship-graph.tsx`](/Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-console/src/components/relationship-graph.tsx)

This adds:

- explicit org/company styling in the graph legend

## Test Artifact

Source used for the loop:

- [`local-brain/examples/steve-friends-raw-story.md`](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/examples/steve-friends-raw-story.md)

Test namespace:

- `personal_story_test`

## Reset / Retest Commands

### Reset namespace

```sql
BEGIN;
DELETE FROM relationship_adjudication_events WHERE namespace_id = 'personal_story_test';
DELETE FROM relationship_memory WHERE namespace_id = 'personal_story_test';
DELETE FROM relationship_candidates WHERE namespace_id = 'personal_story_test';
DELETE FROM claim_candidates WHERE namespace_id = 'personal_story_test';
DELETE FROM memory_entity_mentions WHERE namespace_id = 'personal_story_test';
DELETE FROM entity_aliases WHERE entity_id IN (SELECT id FROM entities WHERE namespace_id = 'personal_story_test');
DELETE FROM entities WHERE namespace_id = 'personal_story_test';
DELETE FROM semantic_decay_events WHERE namespace_id = 'personal_story_test';
DELETE FROM semantic_memory WHERE namespace_id = 'personal_story_test';
DELETE FROM procedural_memory WHERE namespace_id = 'personal_story_test';
DELETE FROM memory_candidates WHERE namespace_id = 'personal_story_test';
DELETE FROM temporal_node_members WHERE namespace_id = 'personal_story_test';
DELETE FROM temporal_nodes WHERE namespace_id = 'personal_story_test';
DELETE FROM episodic_timeline WHERE namespace_id = 'personal_story_test';
DELETE FROM episodic_memory WHERE namespace_id = 'personal_story_test';
DELETE FROM narrative_scenes WHERE namespace_id = 'personal_story_test';
DELETE FROM artifacts WHERE namespace_id = 'personal_story_test';
COMMIT;
```

### Re-ingest and rebuild

```bash
cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain
npm run ingest:file -- ./examples/steve-friends-raw-story.md --source-type markdown_session --namespace personal_story_test --source-channel conversation:personal_story
npm run adjudicate:relationships -- --namespace personal_story_test --limit 200 --accept-threshold 0.6 --reject-threshold 0.4
npm run summarize:temporal -- --namespace personal_story_test
```

## Current Result

The graph is now materially correct for the original story.

Examples that now land correctly:

- `Steve friend_of Lauren`
- `Steve with Lauren`
- `Steve lives_in Chiang Mai`
- `Steve lived_in Koh Samui Island`
- `Dan from Mexico City`
- `Gumi from Iceland`
- `Gumi works_at Icelandic Air`
- `Gumi runs Two Way`
- `Steve friend_of Gumi`
- `Steve hikes_with Gumi`
- `Steve works_at Two Way`
- `Benjamin Williams runs Well Inked`
- `Steve works_with Benjamin Williams`
- `Steve works_at Well Inked`
- `Tim from Australia`
- `Benjamin Williams lived_in France`
- `Benjamin Williams lived_in Singapore`
- `Rafa from Mexico`
- `Renee from Denmark`
- `Renee currently_in Danang`

The graph endpoint now returns the intended core cluster instead of junk nodes:

- `Steve`
- `Lauren`
- `Dan`
- `Gumi`
- `Benjamin Williams`
- `Rafa`
- `Renee`
- `Two Way`
- `Well Inked`
- `Icelandic Air`

## Remaining Imperfections

This path is much better, but not fully “done forever.”

Known remaining gaps:

- `Steve lives_in Thailand` and `Steve lives_in Chiang Mai` both exist. That is acceptable, but later we may want hierarchy-aware place semantics.
- `Koh Samui` and `Koh Samui Island` both exist. That should eventually be normalized or linked.
- `Renee currently_in Danang` and `Renee currently_in Vietnam` both exist. This is semantically valid, but later we may want region containment instead of two flat edges.
- The extractor is still deterministic, not model-backed.
- Relative-time understanding is still limited.
- The global eval suite still has pre-existing failures unrelated to this story loop, especially around older seeded relationship tests and deeper temporal expectations.

## Why This Is The Right Path

This is now close to the architecture we actually want:

- raw Markdown/text remains the truth
- episodic memory remains immutable
- the system stages scenes and claims before promotion
- claims can abstain instead of hallucinating structure
- aliases can evolve
- a future model-backed extractor can replace the deterministic one without changing the memory substrate

## Confidence

For freeform first-person personal narrative ingestion as a system direction:

- `~98%` confidence in the path

For the current deterministic implementation:

- `~88-92%` confidence for stories shaped like the Steve/friends example

The architecture is now right.
The next improvement is not “make the user talk differently.”
The next improvement is:

- better claim extraction models
- better place containment
- stronger relative-time normalization
- eventual deeper claim-to-semantic/procedural promotion
