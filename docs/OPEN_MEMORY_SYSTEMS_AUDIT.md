# Open Memory Systems Audit

Date: 2026-03-24

## Why this exists

AI Brain's internal production gate is now green, but full public long-horizon memory remains weak.
The goal of this audit is to identify open-source memory systems whose concrete design patterns can
be adapted into AI Brain without replacing Postgres, pgvector, MCP, or the current adjudication
model.

This is not a "rewrite around the latest benchmark trend" document. It is a conservative import
plan for the smallest useful patterns.

## Current repo-grounded state

Reference artifacts:

- `local-brain/benchmark-results/production-battle-2026-03-24T14-57-51-103Z.json`
- `local-brain/benchmark-results/relation-bakeoff-2026-03-24T08-11-07-651Z.json`
- `local-brain/benchmark-results/locomo-2026-03-24T12-22-54-419Z.json`
- `local-brain/benchmark-results/public-memory-miss-regressions-2026-03-24T14-53-01-113Z.json`

Current signals:

- Production gate: 100% pass, release gate passed
- Relationship candidate extraction:
  - `gliner_relex`: precision `0.522`, recall `0.750`, F1 `0.615`
  - `spacy`: precision `0.571`, recall `0.250`, F1 `0.348`
- Full LoCoMo:
  - `sampleCount = 1986`
  - `passRate = 0.147`

Interpretation:

- The product-facing memory stack is now solid.
- The relation extraction lane is useful, especially as a candidate-only layer.
- The remaining weakness is not basic storage or basic entity extraction.
- The remaining weakness is long-horizon retrieval breadth, stable profile synthesis, and higher-order
  reasoning over many scattered facts.

## NotebookLM guidance

The Digital Brain notebook provided useful directional advice:

- strengthen sufficiency / abstention control
- test iterative scan for filtered vector retrieval
- add conflict-aware reconsolidation
- improve profile consolidation

I am **not** taking its more aggressive suggestions literally, such as a full hierarchy rewrite or
an immediate graph-first migration.

The NER for Databases notebook repeatedly timed out on the practical architecture questions, so no
clean notebook answer was available there. Repo-grounded evidence still says the same thing:
NER/RE should remain candidate-only and should not become the synthesis or answer-control layer.

## Open repos worth studying

### 1. SimpleMem

Repo:

- `https://github.com/aiming-lab/SimpleMem`

Concrete modules:

- `core/memory_builder.py`
- `core/hybrid_retriever.py`
- `core/answer_generator.py`
- `database/vector_store.py`

What it appears to do well:

- semantic structured compression
- write-time consolidation / synthesis
- query-aware retrieval planning over semantic + lexical + symbolic signals

Why it matters:

- this is the closest public design match to our remaining gaps
- it attacks fragmentation at write time instead of only trying to fix it at read time

What to borrow:

- compact memory-unit construction
- write-time synthesis for repeated related facts
- intent-aware retrieval planning for simple vs complex queries

What not to copy blindly:

- its exact benchmark harness assumptions
- any prompt-only tricks that are not stable under our own production data

### 2. HiMem

Repo:

- `https://github.com/jojopdq/HiMem`

Concrete modules:

- `himem/memory/note_store.py`
- `himem/memory/episode_store.py`
- `himem/components/knowledge_conflict_detector.py`

What it appears to do well:

- separate episodic and note memory
- conflict-aware note updates
- retrieval against both abstract and concrete memory layers

Why it matters:

- AI Brain currently has strong episodic and relationship memory, but still lacks a robust stable
  profile / note layer
- HiMem's note store and conflict detector map directly onto our need for reconsolidation and
  profile snapshots

What to borrow:

- note/profile memory distinct from episodic traces
- conflict detection that classifies add / update / delete style changes
- controlled retrieval of old memories before committing new persistent notes

What not to copy blindly:

- any storage backend assumptions that conflict with our Postgres substrate
- any fully model-owned update logic without provenance guards

### 3. GraphRAG

Repo:

- `https://github.com/microsoft/graphrag`

Concrete modules:

- `packages/graphrag/graphrag/query/factory.py`
- query engines created there:
  - `LocalSearch`
  - `GlobalSearch`
  - `DRIFTSearch`

What it appears to do well:

- explicit separation of local and global question handling
- community-report-backed global synthesis
- different query engines for different scopes of reasoning

Why it matters:

- LoCoMo-style failures often come from asking "whole conversation / whole corpus" questions with a
  flat retrieval pipeline
- we do not need a full GraphRAG rewrite to adopt the most useful idea here: a separate global
  question path

What to borrow:

- route global or corpus-wide questions to a different search path
- precompute summary-like structures for broad profile and commonality questions
- use local search for exact recall and global search for synthesis-heavy prompts

What not to copy blindly:

- full graph-first architecture
- replacing Postgres as the truth substrate

### 4. Hindsight

Repo:

- `https://github.com/vectorize-io/hindsight`

Public signals from README:

- exposes both `recall` and `reflect` APIs
- positions itself as a memory system that learns over time rather than only replaying history

Why it matters:

- even without a deeper code audit yet, the `recall` vs `reflect` split is relevant
- it suggests a useful product distinction:
  - direct recall path for grounded lookup
  - reflective synthesis path for broader profile or reasoning questions

What to borrow:

- separate "retrieve facts" from "reflect over facts"
- keep both backed by provenance and explicit support checks

### 5. MemoryOS / EverMemOS

Repos:

- `https://github.com/xuyongfu/MemoryOS-0630`
- `https://github.com/EverMind-AI/EverMemOS`

Why they matter:

- useful for memory horizon organization
- useful for evaluation harness ideas
- not yet the primary adaptation targets compared to SimpleMem, HiMem, and GraphRAG

## What AI Brain is likely missing

The open-source review reinforces four missing capabilities more than it points to one missing model:

1. Write-time synthesis

- repeated or related evidence should be compacted into a higher-density representation early
- this reduces later fragmentation and retrieval scatter

2. Stable profile / note memory

- recurring identity, role, interests, goals, and long-term status should live in a replayable
  derived layer, not only in episodic rows

3. Conflict-aware reconsolidation

- when new evidence extends or contradicts prior state, the system should revise derived notes in a
  typed way instead of only accumulating more rows

4. Global-question routing

- broad questions should not rely on the same retrieval path as exact fact lookups
- some questions need summary- or community-like context assembly

## Conservative implementation plan

### Priority 1: Add derived profile snapshots

Goal:

- create additive, replayable profile notes for people and entities

Required properties:

- linked back to source evidence
- versioned
- additive only
- never overwrite authoritative episodic rows directly

Use for:

- identity/profile questions
- likely-to-pursue questions
- recurring goals / interests / relationship state

### Priority 2: Add conflict-aware reconsolidation

Goal:

- detect whether new evidence should add, update, or supersede existing profile notes

Start narrow:

- job / employer changes
- residence changes
- current relationship state
- stable preference changes

### Priority 3: Add a global-question lane

Goal:

- separate exact recall from broad synthesis

Examples:

- "What does X have in common with Y?"
- "What has Martin been doing lately?"
- "What is the overall trend in Caroline's plans?"

Implementation idea:

- classify broad or synthesis-heavy queries
- route them to profile-note / summary / clustered evidence assembly before final answer synthesis

### Priority 4: Add write-time synthesis for repeated fact clusters

Goal:

- merge repeated semantically aligned fragments into compact higher-density entries during ingest or
  during a replay/consolidation pass

Start with:

- preferences
- current role / current location
- ongoing projects
- recurring friends / collaborators

### Priority 5: Add an explicit recall vs reflect split

Goal:

- keep exact factual retrieval distinct from broader reflective synthesis

Reason:

- it is easier to defend provenance when the system knows whether the user is asking for a direct
  fact or for a synthesized summary

## Immediate research tasks

1. Inspect `SimpleMem` implementation details in:

- `core/memory_builder.py`
- `core/hybrid_retriever.py`
- `core/answer_generator.py`

Questions:

- how is query complexity inferred?
- how are search subqueries generated?
- how is write-time synthesis triggered?

2. Inspect `HiMem` implementation details in:

- `himem/memory/note_store.py`
- `himem/memory/episode_store.py`
- `himem/components/knowledge_conflict_detector.py`

Questions:

- how are old notes retrieved before updates?
- how are add/update/delete decisions represented?
- how can we adapt this safely into Postgres-derived notes?

3. Inspect `GraphRAG` implementation details in:

- `packages/graphrag/graphrag/query/factory.py`
- local/global/drift query engines

Questions:

- what should trigger our global-question path?
- what minimal precomputed summary structures would help?

4. Inspect `Hindsight` deeper in a future pass

Questions:

- how is `reflect` different from `recall` in practice?
- is there a reusable split we can copy into AI Brain's retrieval API shape?

## What not to do yet

- do not replace Postgres
- do not migrate to a graph-first truth substrate
- do not let NER/RE become the synthesis layer
- do not chase benchmark-specific prompt hacks
- do not add another extractor before we exploit compression, consolidation, and global routing

## Recommended next slice

If only one slice is implemented next, it should be:

1. derived profile snapshots
2. conflict-aware reconsolidation
3. global-question routing

That combination is the best chance to improve both:

- real product memory quality
- full public long-horizon benchmark behavior

