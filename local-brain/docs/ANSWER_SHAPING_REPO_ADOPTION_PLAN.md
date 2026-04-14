# Answer Shaping Repo-Adoption Plan

## Purpose

This document defines the exact surgical plan to eliminate the `answer_shaping`
and `top_snippet` bottleneck in LoCoMo by borrowing the strongest working
patterns from existing open-source systems and integrating them into
`local-brain`.

This is not another heuristic pass.

This plan is not done until:

- `top_snippet` is no longer the dominant failing `finalClaimSource`
- `answer_shaping` drops from the current `775` full-run failures into the low
  hundreds
- the canonical graph/report path becomes the default answer owner for the
  targeted qualitative families

## Current Evidence

### Full unsampled baseline

Artifact:

- `benchmark-results/locomo-2026-04-05T06-30-24-694Z.json`
- `benchmark-results/locomo-2026-04-05T06-30-24-694Z.md`

Key failure distribution:

- normalized failures: `1395`
- `answer_shaping = 775`
- `pass = 220`
- `alias_entity_resolution = 137`
- `temporal = 120`
- `abstention = 104`

Failing final answer sources:

- `top_snippet = 754`
- `canonical_abstention = 227`
- `canonical_temporal = 198`
- `canonical_exact_detail = 85`
- `fallback_derived = 48`
- `canonical_list_set = 44`

Interpretation:

- retrieval is not the main problem
- the system still loses because the wrong layer owns the final answer
- `top_snippet` is still acting like the real answer engine

### Quarter gate before broader report cutover

Artifact:

- `benchmark-results/locomo-2026-04-05T14-21-11-744Z.json`
- `benchmark-results/locomo-2026-04-05T14-21-11-744Z.md`

Key result:

- `passRate = 0.72`
- `answer_shaping = 30`
- `top_snippet = 20`
- `canonical_report = 3`

Interpretation:

- many failing rows still never reached a useful report/narrative path

### Quarter gate after broad report-family cutover

Artifact:

- `benchmark-results/locomo-2026-04-05T14-50-07-658Z.json`
- `benchmark-results/locomo-2026-04-05T14-50-07-658Z.md`

Key result:

- `passRate = 0.693`
- `answer_shaping = 34`
- `canonical_report = 17`
- `top_snippet = 14`

Interpretation:

- broad cutover did shift ownership away from snippets
- but report precision was not good enough, so the system regressed
- the new bottleneck is now report quality and candidate ranking precision

## Root Cause Summary

The problem is no longer “missing structure.”

The problem is that the final answer path still chooses between:

- a generic report candidate
- a raw snippet candidate
- a fallback-derived candidate

without first building and scoring a proper subject-bound neighborhood.

Current local weakness:

1. `lookupStoredNarrativeForQuery()` in
   `src/canonical-memory/narrative-reader.ts` has historically returned the
   first matching report or assembled summary.
2. The candidate pool has been too flat and too early-exit oriented.
3. Broad report cutover makes the wrong report win.
4. Snippet fallback still owns too many rows whenever structured ranking is not
   precise enough.

## What Strong OSS Systems Actually Do

### 1. GraphRAG

Relevant upstream modules:

- `graphrag/query/structured_search/local_search/mixed_context.py`
- `graphrag/query/context_builder/local_context.py`

Pattern:

- map query to entities first
- build mixed context from:
  - entity context
  - relationship context
  - community reports
  - text units
- then answer from that structured context

Important design takeaway:

- the system does not pick a single chunk and hope
- it assembles a query-specific local neighborhood first

### 2. Graphiti

Relevant upstream modules:

- `graphiti_core/search/search.py`
- `graphiti_core/cross_encoder/bge_reranker_client.py`

Pattern:

- search multiple graph scopes in parallel:
  - edges
  - nodes
  - episodes
  - communities
- rerank bounded results with a cross-encoder
- use explicit temporal validity and provenance links

Important design takeaway:

- raw episodes are provenance
- graph truth is primary
- ranking happens across scopes, not one table at a time

### 3. HippoRAG

Relevant upstream modules:

- `src/hipporag/HippoRAG.py`
- `src/hipporag/rerank.py`

Pattern:

- build graph and embedding stores offline for:
  - chunks
  - entities
  - facts
- retrieve graph candidates first
- rerank only after the candidate pool is bounded

Important design takeaway:

- graph-side retrieval happens before answer selection
- reranking is late and narrow

### 4. BGE reranker

Relevant upstream documentation:

- [BGE reranker docs](https://bge-model.com/bge/bge_reranker.html)

Pattern:

- retrieve top `k`
- rerank top `k`
- never use the reranker as the first-stage retrieval engine

Important design takeaway:

- reranking is a cleanup layer, not a substitute for structured retrieval

## What We Will Borrow Exactly

### Borrowed pattern A: GraphRAG local mixed context

We will build our version of `LocalSearchMixedContext` inside the canonical
read path.

Local equivalent:

- `src/canonical-memory/mixed-context.ts`
- `src/canonical-memory/narrative-reader.ts`

Behavior:

1. resolve subject or pair
2. gather candidates from:
   - `canonical_entity_reports`
   - `canonical_pair_reports`
   - `canonical_narratives`
   - canonical facts/states/sets
   - bounded raw narrative/claim sources
3. score them together
4. return one structured candidate to adjudication

Derived local pattern:

```ts
const candidates = [
  ...reports,
  ...pairReports,
  ...narratives,
  ...graphAssembledReports,
  ...rawSourceSummaries
];

const selected = selectMixedContextCandidate(queryText, candidates);
```

### Borrowed pattern B: Graphiti multi-scope ranking

We will copy the multi-scope search idea, not the whole implementation.

Local equivalent:

- `src/canonical-memory/narrative-reader.ts`
- future:
  - `src/canonical-memory/neighborhood-scorer.ts`
  - `src/retrieval/mixed-context-assembly.ts`

Behavior:

- do not rank only one source table at a time
- rank candidate scopes together:
  - canonical report
  - canonical narrative
  - assembled graph summary
  - raw narrative summary

Derived local scoring factors:

- source tier
- query term overlap
- phrase overlap
- support strength
- confidence
- provenance count
- temporal compatibility

### Borrowed pattern C: HippoRAG graph-first candidate discipline

We will borrow the rule that the system must assemble graph candidates before
trying to answer.

Local equivalent:

- `src/canonical-memory/graph-reader.ts`
- `src/canonical-memory/narrative-reader.ts`

Behavior:

- pair/list-set and qualitative profile rows should come from subject-bound
  graph neighborhoods, not generic snippets

### Borrowed pattern D: BGE reranking

We will only add this after local mixed-context selection plateaus.

Local equivalent:

- future `src/canonical-memory/candidate-reranker.ts`

Behavior:

- rerank only top `10-20` canonical candidates
- never rerank the full corpus
- never rerank raw snippets directly

## Local Delta Map

### What we already have

- canonical subjects
- canonical facts
- canonical states
- canonical temporal facts
- canonical sets
- canonical narratives
- canonical entity reports
- canonical pair reports
- family-targeted narrative cutover

### What is still missing

1. Mixed-context neighborhood assembly as the default candidate builder
2. Multi-scope ranking before adjudication
3. Late bounded reranking
4. Clean separation between:
   - report-family failures
   - temporal failures
   - pair/list-set failures
   - binding failures

## Surgical Build Plan

## Phase 0: Lock the rules

Checklist:

- [ ] No new generic snippet reducers
- [ ] No broad family cutovers
- [ ] No full benchmark run until the quarter gate is healthy
- [ ] No reranker before mixed-context assembly is stable

## Phase 1: Replace early-return report lookup with mixed-context assembly

Goal:

- stop returning the first matching report row
- score all relevant structured candidates together

Code surfaces:

- `src/canonical-memory/mixed-context.ts`
- `src/canonical-memory/narrative-reader.ts`

Checklist:

- [x] add `MixedContextCandidate`
- [x] add local multi-scope scorer
- [x] include:
  - canonical reports
  - canonical narratives
  - graph-assembled reports
  - raw-source summaries
- [x] select one structured candidate from the pool
- [x] add tests proving query-specific candidates beat generic reports

Exit gate:

- quarter benchmark must improve over the `0.693` broad-cutover artifact
  or at least reduce `canonical_report` regression failures

## Phase 2: Add explicit neighborhood assembly for qualitative families

Goal:

- stop treating report families as flat summary rows
- build subject-bound neighborhoods first

New local module:

- `src/canonical-memory/neighborhood-scorer.ts`

Candidate inputs:

- subject reports
- pair reports
- canonical facts
- canonical states
- canonical sets
- relationship neighbors
- narrative evidence

Checklist:

- [ ] build single-subject neighborhood assembler
- [ ] build pair-subject neighborhood assembler
- [ ] score neighborhood support by:
  - subject exactness
  - pair exactness
  - predicate family match
  - overlap with query terms
  - provenance count
  - temporal fit
- [ ] feed the best neighborhood result into narrative/report lookup

Exit gate:

- quarter failures that currently say “candidate exists but wrong report wins”
  should shrink materially

## Phase 3: Micro-family cutover only

Goal:

- cut over only the families that survive the quarter gate

Current families:

- `career_report`
- `career_intent`
- `preference_report`
- `education_report`
- `collection_report`
- `aspiration_report`
- `travel_report`
- `pet_care_report`
- `relationship_report`

Rules:

- no global `profile_report` cutover
- no more than one or two new families promoted at once

Checklist:

- [ ] keep `career_report,career_intent` as canary
- [ ] choose the next family only from measured quarter improvements
- [ ] compare quarter artifacts family by family
- [ ] promote only families with clear source and quality gains

Exit gate:

- quarter gate must stay above previous healthy baseline before any new family
  is added to a full run

## Phase 4: Separate non-report bottlenecks

These must not be mixed into report cutover work.

### Temporal lane

Code surfaces:

- `src/canonical-memory/service.ts`
- `src/retrieval/canonical-adjudication.ts`

Checklist:

- [ ] fix month/week/year event selection
- [ ] improve temporal anchoring for “career-high month”, “start year”, and
      “a few years back” style questions

### Pair/list-set lane

Code surfaces:

- `src/canonical-memory/graph-reader.ts`
- `src/retrieval/canonical-adjudication.ts`

Checklist:

- [ ] improve shared place rendering
- [ ] improve symbolic object rendering
- [ ] improve meet-country and pair-plan rendering

### Subject binding lane

Code surfaces:

- `src/retrieval/query-subjects.ts`
- `src/retrieval/subject-plan.ts`
- `src/retrieval/canonical-subject-binding.ts`

Checklist:

- [ ] keep possessive-first binding
- [ ] reduce explicit-name ambiguity in mixed conversations
- [ ] block foreign-subject report wins

## Phase 5: Bounded reranking only if needed

Goal:

- clean up the last candidate-order mistakes after mixed-context assembly works

New module:

- `src/canonical-memory/candidate-reranker.ts`

Checklist:

- [ ] add bounded top-`k` reranking only for canonical candidates
- [ ] use BGE-like cross-encoder pattern
- [ ] measure family-local gains before keeping it

Exit gate:

- only keep reranking if it improves quarter and then full without increasing
  subject-binding regressions

## Schema Plan

No DB replacement.

Use current schema and extend only where needed.

Current required tables already exist:

- `canonical_narratives`
- `canonical_narrative_provenance`
- `canonical_entity_reports`
- `canonical_pair_reports`

Allowed additive schema changes if needed:

- add report provenance counts/materialized support stats
- add subject-neighborhood materialization tables only if runtime scoring becomes
  too slow
- add reranker cache table only if bounded reranking is adopted

Not allowed:

- replacing canonical tables with a new memory subsystem
- adding a second raw narrative store

## Validation Plan

### Unit / regression gates

- [ ] `npm run build --workspace local-brain`
- [ ] `npm run test:canonical-memory-review --workspace local-brain`
- [ ] `npm run test:canonical-adjudication-review --workspace local-brain`
- [ ] add mixed-context scoring regressions for:
  - pet-care
  - career
  - education
  - collection
  - aspiration

### Benchmark gates

1. Quarter gate
   - run the same `150`-question stratified set repeatedly
   - compare against:
     - `locomo-2026-04-05T14-21-11-744Z.json`
     - `locomo-2026-04-05T14-50-07-658Z.json`

2. Full gate
   - only after the quarter gate is healthy
   - compare against:
     - `locomo-2026-04-05T06-30-24-694Z.json`

### Metrics to watch

- `answer_shaping`
- `finalClaimSource=top_snippet`
- `finalClaimSource=canonical_report`
- `finalClaimSource=canonical_narrative`
- `alias_entity_resolution`
- `temporal`
- `narrativePathUsed`
- `reportPathUsed`
- `narrativeCandidateCount`
- `narrativeShadowDecision`

## Done Definition

This issue is not done when we merely have a nicer schema.

This issue is done only when:

- `top_snippet` is no longer the dominant failure source on full unsampled
- `answer_shaping` is reduced dramatically from `775`
- the canonical report/narrative path is measurably owning the targeted
  qualitative families
- broad regressions from report cutover are gone
- the quarter gate is stable enough that full runs move the real score upward

## Immediate Next Task

The next exact step is:

- finish the current quarter benchmark on the new mixed-context scorer
- compare it directly to the prior `0.693` broad-cutover artifact
- keep this mixed-context layer
- then only open the next micro-family that the artifact proves is safe

This is the path to finally killing `answer_shaping` instead of moving it
around between `top_snippet` and a too-broad `canonical_report`.
