# Master Local Brain Spec

## Executive Summary

This document is the healed, consolidated local-first specification for
**Brain 2.0**.

Its purpose is to describe, in one place:

- what the local brain is
- what features are non-negotiable
- how the memory classes work
- how the system should ingest, store, update, forget, and recall
- how the implementation should be sequenced
- what still needs validation before we can claim near-certain build
  confidence

This is the reference spec for the local build.

It has also been re-checked against fresh NotebookLM passes on:

- ingestion architecture
- temporal and relationship recall
- conflict resolution
- forgetting
- local extension stack
- hostile failure-mode critique

Where NotebookLM was helpful, its guidance was folded in.

Where NotebookLM overreached, the spec keeps the architecture intent but marks
the item as a target assumption rather than an already-proven implementation
fact.

## Design Goal

Build a local-first AI brain on an Apple Silicon Mac that:

- preserves raw artifacts as source truth
- supports chat, voice, markdown, PDFs, images, and project files
- models human-like memory through:
  - episodic memory
  - semantic memory
  - procedural memory
- maintains relationship memory and entity graphs
- supports temporal recall across days, weeks, months, years
- answers questions like:
  - "Who was I with in Japan in 2025?"
  - "What changed about my food preferences over the last year?"
- updates active truth without erasing historical truth
- forgets derived low-value information gradually without losing the evidence
  base
- exposes memory through MCP tools so reasoning models remain replaceable

This is not basic RAG.

## Non-Negotiable Features

These features define the target behavior of the local brain and are not being
removed:

1. `PostgreSQL` as the cognitive substrate
2. raw artifact preservation outside the DB
3. tripartite memory:
   - episodic
   - semantic
   - procedural
4. relationship memory and entity graphs
5. time-aware recall
6. Temporal Memory Tree style hierarchy
7. lexical plus vector hybrid retrieval
8. RRF rank fusion
9. provenance on every durable memory path
10. conflict-aware consolidation
11. human-like forgetting through decay of derived memory
12. MCP-based tool access

## Architecture Overview

The system is made of twelve cooperating layers.

### 1. Raw artifact layer

What it does:

- stores the canonical evidence

Examples:

- markdown
- transcripts
- audio
- PDFs
- images
- project files

Why it exists:

- the DB is an index of understanding, not the only copy of reality

### 2. Ingestion and normalization layer

What it does:

- transforms artifacts into fragments and memory candidates

Why it exists:

- whole-document retrieval causes noise and token burn

### 3. Episodic memory

What it does:

- stores raw event history

Why it exists:

- preserves historical truth and temporal order

### 4. Semantic memory

What it does:

- stores distilled knowledge and durable abstractions

Why it exists:

- enables semantic recall without dragging full transcripts into prompts

### 5. Procedural memory

What it does:

- stores active truth:
  - current preferences
  - current project state
  - current skills and rules

Why it exists:

- the system needs a current operational worldview, not only a transcript log

### 6. Relationship memory

What it does:

- tracks entities and edges between them

Why it exists:

- "who was I with" is not solved by vectors alone

### 7. Temporal hierarchy

What it does:

- organizes memory into summaries and time-bounded abstractions

Why it exists:

- human-like long-horizon recall requires time to be a first-class structure

### 8. Retrieval layer

What it does:

- finds evidence through lexical, vector, temporal, and relationship-aware
  search

Why it exists:

- exact match and semantic meaning both matter

### 9. Consolidation layer

What it does:

- promotes durable memory
- deduplicates
- resolves contradictions

Why it exists:

- prevents the brain from becoming a junk drawer

### 10. Forgetting layer

What it does:

- decays low-value derived memory while keeping important anchors and evidence

Why it exists:

- human memory is selective
- retrieval quality depends on controlled forgetting

### 11. Interface layer

What it does:

- exposes the brain through MCP tools

Why it exists:

- the database is the product; the model is replaceable

### 12. Reasoning layer

What it does:

- plans queries
- requests context
- answers and optionally writes back candidate memory

Why it exists:

- memory is necessary but not sufficient for intelligent behavior

## Storage And Retrieval Stack

### Target local stack

- PostgreSQL 18
- TimescaleDB
- `pgvector`
- `pgvectorscale`
- `pgai`
- strong lexical retrieval layer
- SQL RRF

### Current implementation-safe baseline

- PostgreSQL
- `pgvector`
- native PostgreSQL full-text search
- SQL RRF

### Why the baseline exists

It is not a feature reduction.

It is a safe implementation layer that lets us write real artifacts without
pretending every extension path is already operational.

### Upgrade path

- enable TimescaleDB
- enable `pgvectorscale`
- enable `pgai`
- swap the lexical branch to the intended stronger BM25 path once the local
  install path is proven

## Memory Classes In Detail

## Episodic Memory

### Purpose

- historical truth
- raw interactions
- time-ordered evidence

### Must have

- append-only behavior
- timestamps
- provenance to artifacts
- namespace
- session identity

### Example use

- "What happened in Japan in 2025?"

## Semantic Memory

### Purpose

- distilled facts
- recurring patterns
- stable long-term knowledge

### Must have

- embeddings
- importance score
- validity windows
- anchor support
- links back to source evidence

### Example use

- "What do I generally prefer?"

## Procedural Memory

### Purpose

- active truth and current working state

### Must have

- mutable versioned records
- current preferences
- project state
- skills and rule state

### Example use

- "What is my current preference now?"

## Relationship Memory

### Purpose

- entity resolution and graph-like recall

### Must have

- entities
- aliases
- mentions
- relationship edges
- strength or support count
- validity windows

### Example use

- "Who was I with?"

## Temporal Memory And TMT

### Purpose

- long-horizon recall
- time-aware summarization
- timeline zoom-in behavior

### Intended levels

- segment
- session
- day
- week
- month
- profile
- optional year

### Must have

- parent-child links
- interval boundaries
- summary text
- links back to supporting nodes or events

### Example use

- "What changed over the last year?"

## Ingestion Modes

The brain should ingest:

- chat
- text
- markdown
- speech
- audio
- transcript text
- PDFs
- images
- project notes and files
- externally written markdown session logs such as OpenClaw-style memory files

### Ingestion rules

1. preserve the source artifact first
2. extract text or transcript
3. fragment into atomic units
4. attach provenance
5. extract entities and tags
6. request embeddings
7. insert episodic rows
8. stage candidate semantic or procedural writes
9. re-check segmentation during consolidation if long or noisy input was
   chunked poorly

### External markdown ingestion rule

If another system writes markdown to disk while the session is happening, the
brain should ingest that evidence directly.

Preferred pattern:

- file watcher for near-real-time ingestion
- periodic reconciliation scan for correctness
- content hash for idempotency
- versioned observation when a file changes later

This lets tools like OpenClaw remain evidence producers while the brain keeps
the real memory logic inside Postgres.

### Fragment rule

- `1` to `3` sentences

Why:

- reduces token burn
- preserves atomic evidence
- improves retrieval precision

Important:

- the first segmentation pass is not treated as perfect forever
- long dictation, noisy speech, or interleaved topics may need re-segmentation
  during the consolidation cycle

## Provenance Rules

Every durable memory path should support:

- source artifact
- source chunk or offset
- source timestamp where relevant
- namespace
- metadata about extraction
- source content hash
- artifact version or modified-at marker

The brain must be able to answer with evidence, not just with vibes.

### Provenance durability rule

Byte offsets are useful but fragile.

If a source markdown file or transcript is edited later, offsets alone may rot.

So the long-term provenance design should treat:

- file URI as locator
- byte offset as best-effort navigation
- content hash as the durable anchor
- chunk text fingerprint as the recovery mechanism

The artifact registry should preserve enough information to recover evidence even
after file moves or later edits.

## Query And Recall Behavior

The intended query loop is:

1. classify the query
2. extract entities, keywords, and time constraints
3. choose memory layers
4. run lexical and vector retrieval in parallel
5. apply temporal and relationship filters
6. fuse candidates with RRF
7. expand through temporal hierarchy if needed
8. gate results for contradictions and noise
9. answer with provenance

### Retrieval planner rule

The retrieval planner must be explicit about what kind of question is being
asked:

- current-state question
- historical question
- relationship question
- timeline reconstruction question
- project-state question

That classification changes:

- which tables are queried first
- whether active truth filtering is applied
- whether TMT expansion is needed
- whether relationship joins are mandatory
- whether the answer should prefer current truth or historical truth

## Example: Japan 2025

For:

- "Who was I with in Japan in 2025?"

The brain should:

1. resolve `Japan` as a place entity
2. limit the search to the 2025 window
3. search episodic evidence and relevant temporal nodes
4. expand relationship edges for co-mentioned people
5. rank lexical and semantic candidates together
6. return a coherent answer with source references

## Example: Preference Evolution

For:

- "What changed about my food preferences over the last year?"

The brain should:

1. search semantic and procedural preference records
2. include episodic evidence showing when changes were stated
3. compare active truth with superseded truth
4. explain the evolution, not just the current state

## Conflict Resolution

This is one of the most important human-like behaviors.

Example:

- old: `I like spicy food`
- new: `I hate spicy food`

Expected behavior:

- old statement stays in episodic memory
- old durable belief is marked superseded or inactive
- new belief becomes active truth
- retrieval prefers the new active state
- historical queries can still recover the old preference

### Main rules

1. latest durable evidence wins for active truth
2. historical evidence is not erased
3. temporary overrides should not become global truth automatically
4. semantic memory should represent supersession explicitly
5. procedural memory should expose the current operational truth directly
6. daily, weekly, and monthly summaries must record change over time rather than
   flatten contradictions into one timeless statement

### Practical representation

At minimum, the durable memory model should support:

- `valid_from`
- `valid_until`
- `status`
- `superseded_by`
- `confidence`
- `source_artifact_id`

The active truth path should read from the current procedural or semantic record
only when:

- `status` is active
- the record is not superseded
- the query is asking for current truth rather than historical truth

## Human-Like Forgetting

This must remain in the system.

### What should fade

- low-value derived semantic clutter
- stale non-anchor summaries
- repetitive low-signal session notes

### What should not be discarded first

- raw artifacts
- core episodic evidence
- anchor facts
- important relationships
- explicit preference changes
- recurring error patterns
- high-value time-and-place evidence

### Mechanisms

- importance scores
- anchor flags
- access frequency
- validity windows
- semantic decay jobs
- hot / warm / cold tiers
- recall-time gating
- storage-time pruning only for low-value derived memory

### Forgetting rule

The forgetting system is not allowed to silently erase the evidence needed to
explain why the current truth changed.

So the intended order is:

1. raw artifacts kept
2. episodic evidence kept
3. contradictory durable facts marked superseded
4. stale derived summaries decayed
5. only low-value derived memory becomes deletion-eligible

This keeps the brain selective without turning it into a black box.

The point is not to delete the soul of the brain.

The point is to reduce derived clutter.

## Implementation Plan

The local implementation should proceed in phases:

1. substrate bring-up
2. schema package
3. artifact registry
4. ingestion worker
5. episodic memory
6. semantic and procedural memory
7. retrieval
8. relationship layer
9. consolidation
10. relationship extraction and graph consolidation
11. TMT summaries
12. forgetting and cache
13. MCP
14. evaluation harness
15. extension upgrades and benchmarks

## What We Have Already

We already have:

- architecture spec package
- feature preservation matrix
- NotebookLM validation and self-heal pass
- implementation blueprint
- migration skeletons
- worker and tool contracts
- TypeScript scaffold
- NotebookLM slide deck and alignment review

## What Still Needs To Be Built

We still need runnable code for:

- migration runner
- actual database adapter
- artifact registry implementation
- real ingest pipeline
- retrieval service
- relationship joins
- consolidation runner
- summary generation jobs
- MCP handlers

## Validation Gates

We should not call the brain "real" until it passes:

### Schema and install validation

- local extension bring-up is proven
- migrations run cleanly

### Ingestion validation

- markdown and transcript ingestion works end to end
- provenance is intact
- long-form dictation can be re-segmented without losing evidence
- image or PDF ingestion preserves both extracted text and artifact references

### Retrieval validation

- lexical only
- vector only
- hybrid RRF
- time-bounded recall
- relationship-aware recall
- historical truth versus active truth routing
- planner chooses the right retrieval mode for current-state versus historical
  queries

### Memory-change validation

- preference updates supersede correctly
- temporary overrides do not corrupt global truth
- summaries reflect preference change over time instead of flattening it
- outdated facts stop surfacing as active truth

### Timeline validation

- Japan-style queries return coherent evidence-backed timelines
- temporal hierarchy obeys containment rules
- time-zone handling does not leak events into the wrong day or year

### Relationship validation

- people, places, projects, and artifacts are extracted consistently
- relationship edges are written without relying on the chat model to remember to
  do it manually
- repeated evidence can strengthen an existing edge instead of duplicating it

### Token-burn validation

- summary and retrieval logic actually reduce payload size

### Operator validation

- per-query tuning uses `SET LOCAL` or equivalent transaction-scoped settings
- one query cannot poison the connection state for the next query
- vector search parameters are not changed globally by accident

### Provenance robustness validation

- artifact references still work if a file is moved
- evidence can still be recovered if byte offsets drift after later edits

### Evaluation validation

- there is a benchmark set for:
  - current truth
  - historical truth
  - relationship recall
  - timeline reconstruction
  - preference evolution
- retrieval quality is measured over time, not only once

## What Teams Forget

NotebookLM’s hostile critique and my own review agree on these risks:

- forgetting is often left underspecified
- TMT is easy to oversell and hard to tune
- retrieval without evaluation quietly collapses into basic RAG
- extension packaging on local machines is easy to underestimate
- summary quality can drift without being noticed
- byte offsets alone are not durable provenance
- relationship graphs often stay empty unless extraction is mandatory
- one-shot segmentation is not enough for every long or noisy input
- global session settings can leak across pooled DB connections

## Confidence

### Current documentation confidence

- local architecture and implementation direction: `~93%`

### Why not 98% yet

We still need to validate:

- extension bring-up on this machine
- richer lexical path
- `pgvectorscale` local install and benchmark behavior
- consolidation quality
- retrieval quality under real data
- provenance recovery after artifact edits or moves
- real relationship extraction quality
- the evaluation harness against actual personal data

When those are proven, the implementation confidence can rise much higher.

## Final Position

The brain is still the full Brain 2.0.

We are not shrinking:

- memory classes
- relationship memory
- TMT
- hybrid retrieval
- forgetting
- provenance
- conflict-aware updates

We are sequencing implementation so the system can actually be built with high
confidence instead of being described as if it already exists.

Read this spec as:

- full Brain 2.0 target behavior
- explicit current baseline where needed
- explicit upgrade path where extension or packaging work is still pending
- explicit failure modes that must be engineered around
