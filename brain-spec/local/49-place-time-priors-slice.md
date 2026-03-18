# Place / Time / Priors Slice

Date: 2026-03-18

## Goal

Tighten the local brain around four weak points without overbuilding:

- place containment hierarchy
- stronger relative-time normalization
- richer type-specific inbox controls
- graph-history priors beyond scene-local extraction

In parallel, do a lighter UI pass so the console is easier to operate while the graph and inbox get smarter.

## NotebookLM second-brain pass

NotebookLM was re-queried specifically for pragmatic implementation guidance, not hype.

Useful answer summary:

- place containment should stay inside the existing relationship graph with a reserved containment predicate and recursive retrieval expansion
- relative-time normalization should anchor to `captured_at` and nearby scene anchors, not guess dates from thin air
- the inbox should stay typed and outbox-driven, so edits trigger deterministic reprocessing without altering raw evidence
- relationship priors should be advisory scoring features, not a second truth store

That matched the worker research and the current codebase reality, so the slice followed that direction.

## What changed

### 1. Place containment

Added:

- [019_place_time_priors.sql](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/migrations/019_place_time_priors.sql)
- containment candidate seeding in [narrative.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/relationships/narrative.ts)
- recursive descendant support in [service.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/service.ts)

Implementation:

- known place pairs like `Chiang Mai -> Thailand` are staged as `contained_in` relationship candidates
- retrieval now recursively descends active containment edges and pulls episodic location evidence through `memory_entity_mentions`
- results are marked with provenance tier `place_containment_support`

Effect:

- parent-place queries can now surface child-place evidence without requiring the exact parent place name inside the fragment

### 2. Relative-time anchoring

Updated:

- [fragment.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/ingest/fragment.ts)
- [types.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/types.ts)
- [narrative.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/relationships/narrative.ts)

Implementation:

- scenes now carry `anchorBasis`, `anchorSceneIndex`, and `anchorConfidence`
- relative phrases like `last Friday`, `two months ago`, `three weeks later`, and `earlier that year` resolve against:
  - prior scene anchors first
  - `captured_at` second
  - fallback only when no better anchor exists
- scene, event, and claim rows now persist anchor metadata

Effect:

- time is less flat and less brittle
- relative expressions stop collapsing into generic unknown timestamps as often

### 3. Typed ambiguity inbox

Updated:

- [019_place_time_priors.sql](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/migrations/019_place_time_priors.sql)
- [clarifications/service.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/clarifications/service.ts)
- [inbox/page.tsx](/Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-console/src/app/console/inbox/page.tsx)

Implementation:

- ambiguity types now cover richer operator-facing cases, especially:
  - `kinship_resolution`
  - `place_grounding`
  - plus alias/misspelling paths
- the inbox UI now defaults entity type correctly for place-grounding flows and uses clearer copy like `Link and reprocess`
- outbox behavior stays deterministic: resolution updates candidates, then re-materializes mentions/edges without rewriting raw source evidence

Effect:

- vague references like `Uncle` or `summer home` can be surfaced as explicit operator work instead of silently poisoning the graph

### 4. Graph-history priors

Added:

- [relationship-priors.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/jobs/relationship-priors.ts)
- prior-aware relationship scoring in [narrative.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/relationships/narrative.ts)
- refresh hook in [relationship-adjudication.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/jobs/relationship-adjudication.ts)

Implementation:

- `relationship_priors` persists pairwise co-occurrence and accepted-relationship support
- `entity_aliases.neighbor_signatures` stores compact local neighbor hints
- relationship candidate scoring now blends:
  - scene/event-local prior
  - historical pair prior from accepted graph memory and event co-membership

Effect:

- the system has a usable history prior without inventing truth from repetition alone

## Console / graph pass

Merged the useful worker pass:

- switched the console to `Geist` / `Geist Mono`
- kept the top-nav shell
- cleaned up spacing and visual density
- changed the relationship graph to default to the whole visible atlas when no explicit root is selected
- made the graph language clearer:
  - `Show whole atlas`
  - root badge
  - “click Steve to re-root” style guidance

Relevant files:

- [layout.tsx](/Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-console/src/app/layout.tsx)
- [globals.css](/Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-console/src/app/globals.css)
- [console-shell.tsx](/Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-console/src/components/console-shell.tsx)
- [relationship-graph.tsx](/Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-console/src/components/relationship-graph.tsx)
- [relationships/page.tsx](/Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-console/src/app/console/relationships/page.tsx)

## Validation

Passed locally:

- `cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain && npm run check`
- `cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain && npm run migrate`
- `cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain && npm run benchmark:narrative`
- `cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain && npm run eval`
- `cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain && npm run benchmark:lexical`
- `cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-console && npm run lint`
- `cd /Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-console && npm run build`

Latest outcomes:

- narrative benchmark: `4/4`
- eval: all checks passed
- lexical benchmark:
  - `FTS 14/14`
  - `BM25 14/14`
  - fallback `0`
  - recommendation `candidate_for_default`

## Self-review

What went well:

- this stayed within the existing architecture instead of inventing a new subsystem
- the place/time/priors work improved the brain where it was actually weak
- the graph UI is more operator-friendly without becoming a toy

What still is not finished:

- place containment is still curated/lightweight, not ontology-complete
- relative-time normalization is stronger, but not full historical reasoning from arbitrary anchors like `three years before the war`
- neighbor signatures are stored and refreshed, but alias resolution still uses them conservatively
- retrieval fusion is still app-side RRF, not the final SQL-first fused kernel

Confidence after this slice:

- local brain architecture path: `~98%`
- current implementation confidence on the main local track: `~98%`

## Next best moves

- add place-containment diagnostics to the console so you can inspect parent/child chains directly
- deepen relative-time normalization with operator-visible anchor explanations
- add richer graph overlays for superseded beliefs, containment edges, and ambiguity hotspots
- when ready, continue with real OCR / STT / caption workers against the external endpoint
