# Temporal Prefix Guard And Font Pass

Date: 2026-03-18

## What triggered this pass

- The relationship graph showed a bad node: `In June`
- The node had active edges like:
  - `In June -> lives_in -> Chiang Mai`
  - `In June -> lives_in -> Thailand`
- This was confirmed against the live local database and was not a renderer-only issue

## NotebookLM guidance used

NotebookLM was queried for the pragmatic implementation path for:

- place containment with recursive retrieval and cycle safety
- anchored relative-time normalization
- typed ambiguity inbox plus outbox reprocessing
- relationship priors for alias disambiguation

The useful takeaways were:

- keep place containment in the existing graph and add recursive SQL safety
- anchor relative time to `captured_at` and prior resolved events/scenes
- keep ambiguity handling typed and outbox-driven
- keep priors advisory rather than treating them as truth

## Worker takeaways

- UI worker:
  - replace leftover Geist-specific wiring with a standard system font stack
- extractor review worker:
  - the bug path was the sentence-leading subject fallback and other anchored subject regexes
- containment/time/priors review worker:
  - the core architecture is already in place; the remaining work is depth and operator usability
- ambiguity/outbox review worker:
  - current inbox/outbox approach is sound, but state coverage still needs to stay aligned between schema and runtime

## Code changes

### 1. Temporal prefix guard in narrative extraction

Updated:

- [narrative.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/relationships/narrative.ts)

Changes:

- added `stripLeadingTemporalPhrase()`
- applied it before sentence-leading subject extraction
- applied it before anchored subject regexes like:
  - `is from`
  - `passport`
  - `pilot for`
  - `runs`
  - `has lived in`
  - `is currently in`
- tightened unresolved person fallback so raw text is no longer blindly title-cased into a person

Result:

- `In June 2026 Steve was living in Chiang Mai, Thailand` now resolves to:
  - `Steve -> lives_in -> Chiang Mai`
  - `Steve -> lives_in -> Thailand`
- no `In June` entity is created

### 2. Place containment cycle safety

Updated:

- [service.ts](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/src/retrieval/service.ts)

Changes:

- containment recursion now tracks a UUID path
- the recursive CTE blocks revisiting an already-seen location node

Result:

- recursive place expansion is safer against accidental cycles

### 3. Regression coverage

Added:

- [temporal_prefix_subject_guard/case.json](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/examples/golden-stories/temporal_prefix_subject_guard/case.json)
- [temporal_prefix_subject_guard/story.md](/Users/evilone/Documents/Development/AI-Brain/ai-brain/local-brain/examples/golden-stories/temporal_prefix_subject_guard/story.md)

Result:

- the narrative benchmark now includes a direct guard against temporal openers becoming fake people

### 4. Graph hygiene cleanup

Live DB cleanup run:

- removed legacy `In June` person entities from:
  - `personal`
  - `eval_*`

Result:

- the current graph should stop surfacing those stale nodes

### 5. Font cleanup

Updated:

- [layout.tsx](/Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-console/src/app/layout.tsx)
- [globals.css](/Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-console/src/app/globals.css)
- [relationship-graph.tsx](/Users/evilone/Documents/Development/AI-Brain/ai-brain/brain-console/src/components/relationship-graph.tsx)

Changes:

- removed the Geist-specific font loader wiring
- moved the shell and graph labels to a standard system font stack

## Validation

Passed:

- `cd local-brain && npm run check`
- `cd local-brain && npm run benchmark:narrative`
- `cd local-brain && npm run eval`
- `cd brain-console && npm run lint`
- `cd brain-console && npm run build`

Narrative benchmark status:

- `5/5` passed
- includes the new `temporal_prefix_subject_guard` case

## Current interpretation

This pass closes a real extraction bug and improves graph trustworthiness, but it does not mean the memory graph is “finished.” The highest remaining brain-side work is still:

- stronger alias and kinship disambiguation
- deeper place grounding and containment editing
- stronger relative-time chaining for harder narratives
- richer typed inbox actions
- stronger recency-aware graph priors
